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
