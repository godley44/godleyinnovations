// Which handler owns a Slack event — pure so the routing table is
// unit-testable. The architecture rule it encodes: venture channels
// (#lil-bull, …) are the agents' workrooms and keep their existing behavior
// (@mention = health probe, messages logged only); #studio-admin is the
// owner's office and EVERY human message there goes to the AI Manager.

export const STUDIO_ADMIN_CHANNEL = "studio-admin";

export type EventRoute = "manager" | "probe" | "ignore";

export interface RoutableEvent {
  type: string; // "message" | "app_mention" | ...
  channelName: string | null; // resolved from the channel id; null = unknown
  botId?: string;
  subtype?: string;
}

export function classifyEvent(event: RoutableEvent): EventRoute {
  // Loop guard: never react to bot-authored messages (the manager's own
  // replies come back as message events) or edit/system subtypes. The events
  // route also filters these — this is the layer the unit tests pin down.
  if (event.botId || event.subtype) return "ignore";

  if (event.channelName === STUDIO_ADMIN_CHANNEL) {
    // An @mention in #studio-admin arrives TWICE: as app_mention and as a
    // message event. Only the message event drives the manager, so one
    // message never gets two replies; the probe stays reachable via the
    // manager's `health` tool.
    return event.type === "message" ? "manager" : "ignore";
  }

  // Everywhere else: existing behavior, untouched — @mention answers the
  // health probe, plain messages are logged only.
  return event.type === "app_mention" ? "probe" : "ignore";
}
