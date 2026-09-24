// Which handler owns a Slack event — pure so the routing table is
// unit-testable. The architecture rule it encodes: venture channels
// (#lil-bull, …) are the agents' workrooms and keep their existing behavior
// (@mention = health probe, messages logged only); #studio-admin is the
// owner's office and EVERY human message there goes to the AI Manager; and
// a HIGH-TOUCH venture channel (ventures.interaction_mode, migration 008)
// sends every human message — including file drops — to the venture
// content agent, which always answers in the message's thread.

import type { InteractionMode } from "./venture-map.js";

export const STUDIO_ADMIN_CHANNEL = "studio-admin";

export type EventRoute = "manager" | "venture-agent" | "probe" | "ignore";

export interface RoutableEvent {
  type: string; // "message" | "app_mention" | ...
  channelName: string | null; // resolved from the channel id; null = unknown
  botId?: string;
  subtype?: string;
  // The venture behind the channel, when the channel is one: hands_off keeps
  // the original behavior; high_touch routes to the content agent. Omitted
  // or null = not a venture channel (or the lookup failed → old behavior).
  ventureMode?: InteractionMode | null;
}

// The one message subtype that carries a real human message: a file drop.
// Every other subtype (edits, joins, bot_message, thread broadcasts…) is an
// edit/system record and never routes anywhere.
export const FILE_SHARE_SUBTYPE = "file_share";

export function classifyEvent(event: RoutableEvent): EventRoute {
  // Loop guard: never react to bot-authored messages (the manager's and the
  // agent's own replies come back as message events) or edit/system
  // subtypes. The events route also filters these — this is the layer the
  // unit tests pin down.
  if (event.botId) return "ignore";
  if (event.subtype && event.subtype !== FILE_SHARE_SUBTYPE) return "ignore";

  if (event.channelName === STUDIO_ADMIN_CHANNEL) {
    // An @mention in #studio-admin arrives TWICE: as app_mention and as a
    // message event. Only the message event drives the manager, so one
    // message never gets two replies; the probe stays reachable via the
    // manager's `health` tool. A file dropped in #studio-admin is not a
    // manager conversation (the manager is text-only) — ignored.
    if (event.subtype === FILE_SHARE_SUBTYPE) return "ignore";
    return event.type === "message" ? "manager" : "ignore";
  }

  if (event.ventureMode === "high_touch") {
    // Same twice-delivery rule as #studio-admin: the message event drives
    // the agent, the app_mention twin is dropped.
    return event.type === "message" ? "venture-agent" : "ignore";
  }

  // Everywhere else: existing behavior, untouched — @mention answers the
  // health probe, plain messages (and file drops) are logged only.
  return event.type === "app_mention" ? "probe" : "ignore";
}
