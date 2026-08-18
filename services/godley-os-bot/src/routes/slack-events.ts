// POST /slack/events — Slack Events API endpoint.
//
// Slack retries any event not acked within 3 seconds, so the handler does
// nothing slow: verify (middleware), dedupe, log, ack. Real processing runs
// fire-and-forget AFTER the 200 via processEvent(); when the research/framing
// pipeline is built it plugs in there, never before the ack.

import { Hono } from "hono";
import { slackVerify, type SlackVerifiedEnv } from "../lib/slack-verify.js";

interface SlackEvent {
  type: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackEventsBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

// Slack retries events it thinks failed; without dedupe a slow pipeline later
// would run twice. In-memory is acceptable (same trade-off as ai-mesh-bot): a
// restart can at worst double-handle one in-flight event, never loop.
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

// Pipeline hook. Everything here happens after Slack already got its 200, so
// it may become as slow as it likes (Anthropic/OpenAI calls, Supabase writes).
async function processEvent(event: SlackEvent): Promise<void> {
  console.log(
    `[events] ${event.type}${event.subtype ? `/${event.subtype}` : ""} ` +
      `channel=${event.channel ?? "?"} user=${event.user ?? "?"} ` +
      `text=${JSON.stringify(event.text ?? "")}`,
  );
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
    // loop-breaker (bots replying to bots) inherited from ai-mesh-bot. This
    // must survive when real processing replaces the log line.
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
