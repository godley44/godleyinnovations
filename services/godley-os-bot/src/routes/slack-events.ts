// POST /slack/events — Slack Events API endpoint.
//
// Slack retries any event not acked within 3 seconds, so the handler does
// nothing slow: verify (middleware), dedupe, log, ack. Real processing runs
// fire-and-forget AFTER the 200 via processEvent() — including the AI
// Manager's model calls, which take seconds — never before the ack.
//
// Routing (src/lib/manager-routing.ts):
//   #studio-admin, human message   → the AI Manager (src/lib/manager.ts)
//   any other channel, @mention    → the health probe (unchanged)
//   everything else                → logged only (unchanged)

import { Hono } from "hono";
import { buildHealthText } from "../lib/health-text.js";
import { handleManagerMessage } from "../lib/manager.js";
import { classifyEvent } from "../lib/manager-routing.js";
import { getManagerStats } from "../lib/manager-state.js";
import { getPollerState } from "../lib/report-poller.js";
import { getChannelName, postMessage } from "../lib/slack-web.js";
import { slackVerify, type SlackVerifiedEnv } from "../lib/slack-verify.js";

interface SlackEvent {
  type: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackEventsBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

// Slack retries events it thinks failed; without dedupe a slow pipeline
// would run twice — with the manager live, that would mean double replies
// (and double confirmation prompts). In-memory is acceptable (same
// trade-off as ai-mesh-bot): a restart can at worst double-handle one
// in-flight event, never loop.
const seenEvents = new Map<string, number>();
const SEEN_TTL_MS = 10 * 60 * 1000;

function alreadySeen(eventId: string | undefined): boolean {
  const now = Date.now();
  for (const [id, ts] of seenEvents) {
    if (now - ts > SEEN_TTL_MS) seenEvents.delete(id);
  }
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

// Everything here happens after Slack already got its 200, so it may become
// as slow as it likes (Anthropic calls, Supabase reads, Slack posts).
async function processEvent(event: SlackEvent): Promise<void> {
  console.log(
    `[events] ${event.type}${event.subtype ? `/${event.subtype}` : ""} ` +
      `channel=${event.channel ?? "?"} user=${event.user ?? "?"} ` +
      `text=${JSON.stringify(event.text ?? "")}`,
  );

  const channelName = event.channel ? await getChannelName(event.channel) : null;
  const route = classifyEvent({
    type: event.type,
    channelName,
    botId: event.bot_id,
    subtype: event.subtype,
  });

  if (route === "manager" && event.channel && event.user && event.ts) {
    await handleManagerMessage({
      channel: event.channel,
      user: event.user,
      text: event.text ?? "",
      ts: event.ts,
      threadTs: event.thread_ts,
    });
    return;
  }

  // An @mention is the health probe: answer in-thread with version, poller
  // status, the last delivery check, and manager stats, so the bot can be
  // checked from a phone without opening Render logs.
  if (route === "probe" && event.channel && event.ts) {
    await postMessage({
      channel: event.channel,
      // Replying in the mention's thread (or starting one on it) keeps the
      // probe out of the channel's main scroll.
      threadTs: event.thread_ts ?? event.ts,
      text: buildHealthText(getPollerState(), getManagerStats()),
    });
  }
}

export const slackEvents = new Hono<SlackVerifiedEnv>();

slackEvents.post("/", slackVerify, (c) => {
  const rawBody = c.get("rawBody");

  let body: SlackEventsBody;
  try {
    body = JSON.parse(rawBody) as SlackEventsBody;
  } catch {
    return c.text("body must be JSON", 400);
  }

  // Slack's one-time endpoint handshake during app setup: echo the challenge
  // back as plain text. The handshake request is signed like any other, so it
  // passes the middleware above.
  if (body.type === "url_verification") {
    return c.text(body.challenge ?? "", 200);
  }

  if (body.type === "event_callback" && body.event && !alreadySeen(body.event_id)) {
    const event = body.event;
    const isMention = event.type === "app_mention";
    const isChannelMessage = event.type === "message" && event.channel_type === "channel";
    // Never react to bot-authored messages or edit/system subtypes — the
    // loop-breaker (bots replying to bots) inherited from ai-mesh-bot. The
    // manager's own replies come back as bot messages, so this is what
    // keeps it from talking to itself; classifyEvent checks it again.
    const isHuman = !event.bot_id && !event.subtype;
    if ((isMention || isChannelMessage) && isHuman) {
      // Fire-and-forget: the 200 below goes out now, processing runs after.
      processEvent(event).catch((err) => {
        console.error("[events] processEvent failed:", err);
      });
    }
  }

  // 200 for everything, including event types we ignore — anything else makes
  // Slack retry and eventually disable the event subscription.
  return c.text("ok", 200);
});
