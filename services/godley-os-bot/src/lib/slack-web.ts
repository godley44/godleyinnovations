// Slack Web API over plain fetch — no Slack SDK, same policy as
// slack-verify.ts. Only the methods the bot actually uses. Every call either
// succeeds or throws with Slack's own error string, so a Slack-side refusal
// (missing scope, unknown channel) can never be mistaken for success.
//
// All calls are form-encoded: every Web API method accepts
// application/x-www-form-urlencoded, but only some accept JSON bodies —
// one encoding that always works beats two that sometimes do. Non-string
// values (blocks arrays, booleans) are JSON-encoded into their form field,
// which is exactly what Slack expects for rich arguments.

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackApi(method: string, params: Record<string, unknown>): Promise<SlackApiResponse> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as SlackApiResponse;
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error ?? "unknown error"}`);
  return body;
}

export interface SlackChannel {
  id: string;
  name: string;
  isMember: boolean;
}

// conversations.list is Tier-2 rate limited (~20/min), so the roster is
// cached. Correctness doesn't depend on freshness — a channel created or
// joined mid-TTL just waits one refresh; nothing is ever posted to a stale
// id because posting also fails loudly on Slack's side.
const CHANNEL_CACHE_TTL_MS = 15 * 60 * 1000;
let channelCache: { at: number; byName: Map<string, SlackChannel> } | null = null;

export async function listChannelsByName(): Promise<Map<string, SlackChannel>> {
  if (channelCache && Date.now() - channelCache.at < CHANNEL_CACHE_TTL_MS) {
    return channelCache.byName;
  }
  const byName = new Map<string, SlackChannel>();
  let cursor: string | undefined;
  do {
    const page = await slackApi("conversations.list", {
      types: "public_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    const channels = Array.isArray(page.channels) ? page.channels : [];
    for (const raw of channels) {
      const ch = raw as { id?: unknown; name?: unknown; is_member?: unknown };
      if (typeof ch.id === "string" && typeof ch.name === "string") {
        byName.set(ch.name, { id: ch.id, name: ch.name, isMember: ch.is_member === true });
      }
    }
    const meta = page.response_metadata as { next_cursor?: string } | undefined;
    cursor = meta?.next_cursor || undefined;
  } while (cursor);
  channelCache = { at: Date.now(), byName };
  return byName;
}

// Channel id → name (conversations.info), cached per id: the events route
// resolves every incoming event's channel to decide studio-admin vs venture
// routing, and names effectively never change mid-session. A lookup failure
// returns null (the caller falls back to venture-channel behavior) — it
// never throws, because routing must not break event handling.
const CHANNEL_NAME_TTL_MS = 15 * 60 * 1000;
const channelNameCache = new Map<string, { at: number; name: string }>();

export async function getChannelName(channelId: string): Promise<string | null> {
  const cached = channelNameCache.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_NAME_TTL_MS) return cached.name;
  try {
    const res = await slackApi("conversations.info", { channel: channelId });
    const name = (res.channel as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string") return null;
    channelNameCache.set(channelId, { at: Date.now(), name });
    return name;
  } catch (err) {
    console.error(
      `[slack] conversations.info failed for ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface HistoryMessage {
  ts: string;
  userId?: string;
  botId?: string;
  subtype?: string;
  text: string;
}

function normalizeHistoryMessage(raw: unknown): HistoryMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.ts !== "string") return null;
  return {
    ts: m.ts,
    userId: typeof m.user === "string" ? m.user : undefined,
    botId: typeof m.bot_id === "string" ? m.bot_id : undefined,
    subtype: typeof m.subtype === "string" ? m.subtype : undefined,
    text: typeof m.text === "string" ? m.text : "",
  };
}

// Recent conversation context for the AI Manager, oldest-first: the thread's
// replies when threadTs is given (conversations.replies), else the
// channel's main scroll (conversations.history — thread replies don't
// appear there, matching what the owner sees). Needs the channels:history
// scope, which the message.channels event subscription already requires.
export async function fetchRecentMessages(args: {
  channel: string;
  threadTs?: string;
  limit: number;
}): Promise<HistoryMessage[]> {
  // conversations.history pages NEWEST-first (limit N = the N most recent),
  // but conversations.replies pages OLDEST-first — a small limit there
  // would return a long thread's start, not its tail. So replies fetch a
  // big page and the tail is taken after sorting.
  const res = args.threadTs
    ? await slackApi("conversations.replies", { channel: args.channel, ts: args.threadTs, limit: 200 })
    : await slackApi("conversations.history", { channel: args.channel, limit: args.limit });
  const messages = (Array.isArray(res.messages) ? res.messages : [])
    .map(normalizeHistoryMessage)
    .filter((m): m is HistoryMessage => m !== null)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  return messages.slice(-args.limit);
}

export interface PostMessageArgs {
  channel: string;
  text: string; // notification fallback when blocks are present
  blocks?: unknown[];
  threadTs?: string;
}

// Returns the posted message's ts (Slack's message id within the channel).
export async function postMessage(args: PostMessageArgs): Promise<string> {
  const res = await slackApi("chat.postMessage", {
    channel: args.channel,
    text: args.text,
    blocks: args.blocks,
    thread_ts: args.threadTs,
    unfurl_links: false,
  });
  return typeof res.ts === "string" ? res.ts : "";
}

// A file the owner dropped in a channel, as the message event carries it.
export interface SlackFileRef {
  id: string;
  name: string;
  mimetype: string;
  urlPrivateDownload: string | null;
  size: number | null;
}

export function normalizeFileRef(raw: unknown): SlackFileRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string") return null;
  const url =
    typeof f.url_private_download === "string"
      ? f.url_private_download
      : typeof f.url_private === "string"
        ? f.url_private
        : null;
  return {
    id: f.id,
    name: typeof f.name === "string" && f.name ? f.name : f.id,
    mimetype: typeof f.mimetype === "string" ? f.mimetype : "",
    urlPrivateDownload: url,
    size: typeof f.size === "number" ? f.size : null,
  };
}

// Thrown when Slack answers a file download with something other than the
// file — the one non-transient cause is a token without the files:read
// scope, which the caller turns into a "WHAT JUSTIN DOES" instruction.
export class SlackFileScopeError extends Error {
  constructor(detail: string) {
    super(`Slack refused the file download (${detail}) — the app needs the files:read scope: add it under OAuth & Permissions and reinstall the app`);
    this.name = "SlackFileScopeError";
  }
}

// Download a private Slack file (url_private_download) with the bot token.
// Requires the files:read scope: without it Slack answers 403, or a 200 HTML
// sign-in page — both are reported as SlackFileScopeError, never mistaken
// for image bytes. The token goes in the Authorization header only.
export async function downloadFile(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  if (!/^https:\/\/files\.slack\.com\//.test(url) && !/^https:\/\/[a-z0-9-]+\.slack\.com\//.test(url)) {
    throw new Error("refusing to send the bot token to a non-Slack URL");
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" });
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403) throw new SlackFileScopeError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`Slack file download: HTTP ${res.status}`);
  if (/text\/html/i.test(contentType)) throw new SlackFileScopeError("got an HTML sign-in page instead of the file");
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
}

// Rewrite an existing bot message in place (chat.update) — used to disarm an
// approval prompt whose proposal was decided outside Slack. Passing blocks
// REPLACES the old blocks entirely, which is the point: the buttons go away.
export async function updateMessage(args: {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}): Promise<void> {
  await slackApi("chat.update", {
    channel: args.channel,
    ts: args.ts,
    text: args.text,
    blocks: args.blocks,
  });
}
