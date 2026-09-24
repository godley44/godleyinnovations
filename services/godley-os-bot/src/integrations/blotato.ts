// Blotato publishing client — plain fetch, no SDK, same policy as every
// other HTTP integration here. Every request/response shape below was
// verified against help.blotato.com (rest-api-reference: publish-post,
// upload-media-v2-media, accounts, accounts-and-identifiers) and the live
// OpenAPI spec (backend.blotato.com/openapi.json); do not extend a shape
// without re-reading those docs.
//
// ONE KEY PER VENTURE. Every call is made on behalf of a venture and uses
// THAT venture's key: BLOTATO_API_KEY__<SLUG_UPPER_SNAKE>, e.g.
// BLOTATO_API_KEY__COUPLESTHERAPY101, BLOTATO_API_KEY__KINGDOM_BUILDING_OS.
// The un-suffixed BLOTATO_API_KEY is the legacy shared key and is the
// fallback for exactly one venture — lil-bull, whose production setup
// predates per-venture keys. It is deliberately NOT a fallback for anyone
// else: a venture without its own key runs in dry-run, because publishing
// (or listing accounts for a sync) with another venture's key would be a
// cross-venture leak, the one thing the whole schema is built to prevent.
//
// DRY RUN: with no real key for the venture (unset, or the "pending"
// placeholder the Render env ships with) or BLOTATO_DRY_RUN=1, publishPost()
// and uploadMedia() log the exact request they WOULD send and return
// { dryRun: true } — the whole approval→publish chain is testable end-to-end
// before a real key exists (generating the key starts Blotato billing, so
// it arrives only at live-test time). A dry run is an explicit result,
// never a silent no-op.
//
// Publishing is ASYNC on Blotato's side: POST /v2/posts answers 201 with a
// postSubmissionId; the real outcome comes later from
// GET /v2/posts/:postSubmissionId (in-progress → published | failed, 60
// requests/minute). Blotato's docs say "Do not retry on failed — most
// failures are permanent", which matches this repo's terminal-failure
// discipline exactly.
//
// Media: Blotato accepts any publicly accessible media URL directly in
// mediaUrls, and also offers POST /v2/media { url } → 201 { url } which
// copies the file to Blotato's own hosting (30 requests/minute). The
// executor uploads first so a publish never depends on a third host staying
// up mid-publish; the returned Blotato URL is what goes into mediaUrls.
//
// Key hygiene: the key travels only in the blotato-api-key header (Blotato
// keys may end in "=" padding — preserved verbatim, never trimmed); errors
// carry the HTTP status and Blotato's message, never headers.

const BLOTATO_BASE_URL = "https://backend.blotato.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const PLACEHOLDER_KEY = "pending";

// The one venture the un-suffixed BLOTATO_API_KEY still serves (see header).
export const LEGACY_SHARED_KEY_SLUG = "lil-bull";

export type BlotatoPlatform = "twitter" | "linkedin" | "youtube" | "instagram" | "facebook";

// Per-platform target objects, exactly as documented (help.blotato.com
// rest-api-reference/publish-post: youtube requires title, privacyStatus,
// shouldNotifySubscribers and accepts containsSyntheticMedia; instagram's
// optional mediaType is "reel" for a video and omitted for a feed image;
// facebook requires the Page id).
export type PublishTarget =
  | { targetType: "twitter" }
  | { targetType: "linkedin"; pageId?: string }
  | {
      targetType: "youtube";
      title: string;
      privacyStatus: "private" | "public" | "unlisted";
      shouldNotifySubscribers: boolean;
      containsSyntheticMedia: boolean;
    }
  | { targetType: "instagram"; mediaType?: "reel" }
  | { targetType: "facebook"; pageId: string };

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
  facebookPageId?: string; // REQUIRED for facebook (a Page is the only destination)
  instagramMediaType?: "reel" | "image"; // a video Reel or a feed image; omitted = inferred from the first media url
  youtube?: {
    title: string;
    privacyStatus: "private" | "public" | "unlisted";
    shouldNotifySubscribers: boolean;
  };
}

// Instagram's mediaType is inferred from the file when the caller does not
// say: a video file publishes as a Reel, anything else as a feed image.
function looksLikeVideo(url: string): boolean {
  return /\.(mp4|mov|m4v|webm|avi)(\?|#|$)/i.test(url);
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
  } else if (args.platform === "instagram") {
    // Instagram's feed has no text-only post; the schema only requires
    // targetType, so the media rule is enforced here, before any claim. A
    // video publishes as a Reel (mediaType "reel"); an image as a feed post.
    if (args.mediaUrls.length === 0) {
      throw new Error("instagram: an image or video mediaUrl is required — text-only posts cannot publish to Instagram");
    }
    const reel = args.instagramMediaType === "reel" || (args.instagramMediaType === undefined && looksLikeVideo(args.mediaUrls[0]!));
    target = reel ? { targetType: "instagram", mediaType: "reel" } : { targetType: "instagram" };
  } else if (args.platform === "facebook") {
    // Facebook publishes to a PAGE: pageId is a required field of the
    // documented target (page ids come from the subaccounts endpoint via the
    // account sync — see listSubaccounts).
    if (!args.facebookPageId) {
      throw new Error(
        "facebook: a Page id is required (venture_platforms.blotato_page_id) — run the Blotato account sync for this venture",
      );
    }
    target = { targetType: "facebook", pageId: args.facebookPageId };
  } else {
    // YouTube is a video platform: the docs require a title and privacy
    // flags, and a post with no media has nothing to upload. The narration
    // is an AI-cloned voice, so the synthetic-media disclosure is always on.
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
      containsSyntheticMedia: true,
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

// --- Key resolution ----------------------------------------------------------

// couplestherapy101 → BLOTATO_API_KEY__COUPLESTHERAPY101,
// kingdom-building-os → BLOTATO_API_KEY__KINGDOM_BUILDING_OS.
export function ventureKeyName(ventureSlug: string): string {
  return `BLOTATO_API_KEY__${ventureSlug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export interface ResolvedKey {
  // The usable key, or null when none is configured for this venture.
  key: string | null;
  // Which env var supplied it (names only — never logged with the value).
  source: "venture" | "shared" | "none";
  // Every configured-but-placeholder key counts as "none" for publishing.
  placeholder: boolean;
}

export function resolveBlotatoKey(ventureSlug: string): ResolvedKey {
  const own = process.env[ventureKeyName(ventureSlug)];
  if (own !== undefined && own !== "") {
    return own === PLACEHOLDER_KEY
      ? { key: null, source: "venture", placeholder: true }
      : { key: own, source: "venture", placeholder: false };
  }
  if (ventureSlug === LEGACY_SHARED_KEY_SLUG) {
    const shared = process.env.BLOTATO_API_KEY;
    if (shared !== undefined && shared !== "") {
      return shared === PLACEHOLDER_KEY
        ? { key: null, source: "shared", placeholder: true }
        : { key: shared, source: "shared", placeholder: false };
    }
  }
  return { key: null, source: "none", placeholder: false };
}

export function isDryRun(ventureSlug: string): boolean {
  return resolveBlotatoKey(ventureSlug).key === null || process.env.BLOTATO_DRY_RUN === "1";
}

// The human-readable reason a venture is in dry-run — for logs, replies and
// the ledger, names only.
export function dryRunReason(ventureSlug: string): string {
  if (process.env.BLOTATO_DRY_RUN === "1") return "BLOTATO_DRY_RUN=1";
  const resolved = resolveBlotatoKey(ventureSlug);
  if (resolved.placeholder) {
    return `${resolved.source === "shared" ? "BLOTATO_API_KEY" : ventureKeyName(ventureSlug)} is the "pending" placeholder`;
  }
  return `no ${ventureKeyName(ventureSlug)} in the environment`;
}

function requireKey(ventureSlug: string): string {
  const resolved = resolveBlotatoKey(ventureSlug);
  if (resolved.key === null) {
    throw new Error(
      `a real ${ventureKeyName(ventureSlug)} is required for this call (${dryRunReason(ventureSlug)} keeps ${ventureSlug} in dry-run mode)`,
    );
  }
  return resolved.key;
}

async function blotatoFetch(
  ventureSlug: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<Response> {
  const key = requireKey(ventureSlug);
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

// --- Media -------------------------------------------------------------------

export type UploadMediaResult = { dryRun: true; wouldSend: { url: string } } | { dryRun: false; url: string };

// POST /v2/media { url } → 201 { url }: copies a publicly reachable file to
// Blotato's hosting and returns the URL to publish with.
export async function uploadMedia(ventureSlug: string, sourceUrl: string): Promise<UploadMediaResult> {
  if (!/^https?:\/\//.test(sourceUrl)) throw new Error("uploadMedia: the source must be a public http(s) URL");
  if (isDryRun(ventureSlug)) {
    console.log(
      `[blotato] DRY RUN (${ventureSlug}: ${dryRunReason(ventureSlug)}) — would POST ${BLOTATO_BASE_URL}/media ` +
        `${JSON.stringify({ url: sourceUrl })}`,
    );
    return { dryRun: true, wouldSend: { url: sourceUrl } };
  }
  const res = await blotatoFetch(ventureSlug, "/media", { method: "POST", body: { url: sourceUrl } });
  if (res.status !== 201) {
    throw new Error(`Blotato media upload rejected: ${await errorDetail(res)}`);
  }
  const body = (await res.json()) as { url?: unknown };
  if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
    throw new Error("Blotato media upload returned 201 without a hosted url");
  }
  return { dryRun: false, url: body.url };
}

// --- Publishing --------------------------------------------------------------

export type PublishResult =
  | { dryRun: true; wouldSend: PublishRequest }
  | { dryRun: false; postSubmissionId: string };

export async function publishPost(ventureSlug: string, request: PublishRequest): Promise<PublishResult> {
  if (isDryRun(ventureSlug)) {
    console.log(
      `[blotato] DRY RUN (${ventureSlug}: ${dryRunReason(ventureSlug)}) — would POST ${BLOTATO_BASE_URL}/posts for ` +
        `${request.post.content.platform} (account ${request.post.accountId}): ${JSON.stringify(request)}`,
    );
    return { dryRun: true, wouldSend: request };
  }
  const res = await blotatoFetch(ventureSlug, "/posts", { method: "POST", body: request });
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

export async function getPostStatus(ventureSlug: string, postSubmissionId: string): Promise<PostStatus> {
  const res = await blotatoFetch(ventureSlug, `/posts/${encodeURIComponent(postSubmissionId)}`, { method: "GET" });
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

// --- Accounts ----------------------------------------------------------------

export interface BlotatoAccount {
  id: string;
  platform: string;
  fullname: string;
  username: string;
}

// Account discovery for wiring venture_platforms.blotato_account_id —
// GET /v2/users/me/accounts with THIS venture's key, so the ids that come
// back can only ever be this venture's. Requires the real key by definition.
export async function listAccounts(ventureSlug: string): Promise<BlotatoAccount[]> {
  const res = await blotatoFetch(ventureSlug, "/users/me/accounts", { method: "GET" });
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

export interface BlotatoSubaccount {
  id: string; // the Page id — target.pageId for facebook (and linkedin company pages)
  name: string;
}

// Facebook Pages (and LinkedIn Company Pages) are SUBACCOUNTS of the connected
// account, not accounts of their own: GET /v2/users/me/accounts/:id/subaccounts
// → { items: [{ id, accountId, name }] }; items[].id is what the facebook
// target's pageId takes. The docs also spell the field `pageId` in one
// place, so both are accepted.
export async function listSubaccounts(ventureSlug: string, accountId: string): Promise<BlotatoSubaccount[]> {
  const res = await blotatoFetch(ventureSlug, `/users/me/accounts/${encodeURIComponent(accountId)}/subaccounts`, {
    method: "GET",
  });
  if (!res.ok) throw new Error(`Blotato subaccounts listing failed for account ${accountId}: ${await errorDetail(res)}`);
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  return items.flatMap((raw) => {
    const s = raw as Record<string, unknown>;
    const id = typeof s.pageId === "string" ? s.pageId : typeof s.id === "string" ? s.id : null;
    return id ? [{ id, name: typeof s.name === "string" ? s.name : "" }] : [];
  });
}
