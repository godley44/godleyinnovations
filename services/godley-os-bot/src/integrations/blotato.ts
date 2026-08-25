// Blotato publishing client — plain fetch, no SDK, same policy as every
// other HTTP integration here. Every request/response shape below was
// verified against help.blotato.com/api (publish-post, accounts, get-post);
// do not extend a shape without re-reading those docs.
//
// DRY RUN: with no real key (unset, or the "pending" placeholder the Render
// env ships with) or BLOTATO_DRY_RUN=1, publishPost() logs the exact request
// it WOULD send and returns { dryRun: true } — the whole approval→publish
// chain is testable end-to-end before a real key exists (generating the key
// starts Blotato billing, so it arrives only at live-test time). A dry run
// is an explicit result, never a silent no-op.
//
// Publishing is ASYNC on Blotato's side: POST /v2/posts answers 201 with a
// postSubmissionId; the real outcome comes later from
// GET /v2/posts/:postSubmissionId (in-progress → published | failed, 60
// requests/minute). Blotato's docs say "Do not retry on failed — most
// failures are permanent", which matches this repo's terminal-failure
// discipline exactly.
//
// Key hygiene: the key travels only in the blotato-api-key header (Blotato
// keys may end in "=" padding — preserved verbatim, never trimmed); errors
// carry the HTTP status and Blotato's message, never headers.

const BLOTATO_BASE_URL = "https://backend.blotato.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const PLACEHOLDER_KEY = "pending";

export type BlotatoPlatform = "twitter" | "linkedin" | "youtube";

// Per-platform target objects, exactly as documented.
export type PublishTarget =
  | { targetType: "twitter" }
  | { targetType: "linkedin"; pageId?: string }
  | {
      targetType: "youtube";
      title: string;
      privacyStatus: "private" | "public" | "unlisted";
      shouldNotifySubscribers: boolean;
    };

// The POST /v2/posts body. scheduledTime/useNextFreeSlot are deliberately
// NOT modeled: the approval gate is the only path to publishing, so every
// publish is immediate — omitting both is how the API expresses that.
export interface PublishRequest {
  post: {
    accountId: string;
    content: { text: string; mediaUrls: string[]; platform: BlotatoPlatform };
    target: PublishTarget;
  };
}

export interface BuildPublishArgs {
  platform: BlotatoPlatform;
  accountId: string;
  text: string;
  mediaUrls: string[]; // must be PUBLICLY accessible URLs; [] = text-only
  linkedinPageId?: string; // omit → personal profile
  youtube?: {
    title: string;
    privacyStatus: "private" | "public" | "unlisted";
    shouldNotifySubscribers: boolean;
  };
}

// Pure request construction with the per-platform requirements enforced
// here, so an impossible publish fails before any claim or network call.
export function buildPublishRequest(args: BuildPublishArgs): PublishRequest {
  if (!args.accountId) throw new Error(`${args.platform}: Blotato accountId is not configured`);
  let target: PublishTarget;
  if (args.platform === "twitter") {
    target = { targetType: "twitter" };
  } else if (args.platform === "linkedin") {
    target =
      args.linkedinPageId === undefined
        ? { targetType: "linkedin" }
        : { targetType: "linkedin", pageId: args.linkedinPageId };
  } else {
    // YouTube is a video platform: the docs require a title and privacy
    // flags, and a post with no media has nothing to upload.
    if (args.mediaUrls.length === 0) {
      throw new Error("youtube: a video mediaUrl is required — text-only posts cannot publish to YouTube");
    }
    if (!args.youtube || !args.youtube.title.trim()) {
      throw new Error("youtube: title and privacy settings are required");
    }
    target = {
      targetType: "youtube",
      title: args.youtube.title,
      privacyStatus: args.youtube.privacyStatus,
      shouldNotifySubscribers: args.youtube.shouldNotifySubscribers,
    };
  }
  return {
    post: {
      accountId: args.accountId,
      content: { text: args.text, mediaUrls: args.mediaUrls, platform: args.platform },
      target,
    },
  };
}

export function isDryRun(): boolean {
  const key = process.env.BLOTATO_API_KEY;
  return !key || key === PLACEHOLDER_KEY || process.env.BLOTATO_DRY_RUN === "1";
}

function requireKey(): string {
  const key = process.env.BLOTATO_API_KEY;
  if (!key || key === PLACEHOLDER_KEY) {
    throw new Error(
      "a real BLOTATO_API_KEY is required for this call (the placeholder keeps publishing in dry-run mode)",
    );
  }
  return key;
}

async function blotatoFetch(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Response> {
  const key = requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${BLOTATO_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        "blotato-api-key": key,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Blotato ${path}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Blotato ${path}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Surface Blotato's own error message — never our request headers.
async function errorDetail(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    const message = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : null;
    if (message) detail = `HTTP ${res.status}: ${message}`;
  } catch {
    // Non-JSON error body — the status alone will have to do.
  }
  return detail;
}

export type PublishResult =
  | { dryRun: true; wouldSend: PublishRequest }
  | { dryRun: false; postSubmissionId: string };

export async function publishPost(request: PublishRequest): Promise<PublishResult> {
  if (isDryRun()) {
    console.log(
      `[blotato] DRY RUN — would POST ${BLOTATO_BASE_URL}/posts for ` +
        `${request.post.content.platform} (account ${request.post.accountId}): ${JSON.stringify(request)}`,
    );
    return { dryRun: true, wouldSend: request };
  }
  const res = await blotatoFetch("/posts", { method: "POST", body: request });
  if (res.status !== 201) {
    throw new Error(`Blotato publish rejected: ${await errorDetail(res)}`);
  }
  const body = (await res.json()) as { postSubmissionId?: unknown };
  if (typeof body.postSubmissionId !== "string" || !body.postSubmissionId) {
    throw new Error("Blotato publish returned 201 without a postSubmissionId");
  }
  return { dryRun: false, postSubmissionId: body.postSubmissionId };
}

export interface PostStatus {
  postSubmissionId: string;
  status: "in-progress" | "scheduled" | "published" | "failed";
  publicUrl?: string;
  errorMessage?: string;
}

export async function getPostStatus(postSubmissionId: string): Promise<PostStatus> {
  const res = await blotatoFetch(`/posts/${encodeURIComponent(postSubmissionId)}`, { method: "GET" });
  if (!res.ok) throw new Error(`Blotato post status failed: ${await errorDetail(res)}`);
  const body = (await res.json()) as Record<string, unknown>;
  const status = body.status;
  if (status !== "in-progress" && status !== "scheduled" && status !== "published" && status !== "failed") {
    throw new Error(`Blotato post status returned unknown status ${JSON.stringify(status)}`);
  }
  return {
    postSubmissionId,
    status,
    publicUrl: typeof body.publicUrl === "string" ? body.publicUrl : undefined,
    errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
  };
}

export interface BlotatoAccount {
  id: string;
  platform: string;
  fullname: string;
  username: string;
}

// Account discovery for wiring venture_platforms.blotato_account_id at
// live-test time. Requires the real key by definition.
export async function listAccounts(): Promise<BlotatoAccount[]> {
  const res = await blotatoFetch("/users/me/accounts", { method: "GET" });
  if (!res.ok) throw new Error(`Blotato accounts listing failed: ${await errorDetail(res)}`);
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  return items.flatMap((raw) => {
    const a = raw as Record<string, unknown>;
    return typeof a.id === "string" && typeof a.platform === "string"
      ? [
          {
            id: a.id,
            platform: a.platform,
            fullname: typeof a.fullname === "string" ? a.fullname : "",
            username: typeof a.username === "string" ? a.username : "",
          },
        ]
      : [];
  });
}
