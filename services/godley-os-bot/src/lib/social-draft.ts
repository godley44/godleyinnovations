// Pure validation + row-building for POST /admin/social-draft — the manual
// entry point that turns owner input into a content_calendar row plus a
// 'social.post' proposal riding the existing approval rails. Kept free of
// I/O so the rules are unit-testable.
//
// Hard rules enforced here, before anything touches the database:
//  - platforms must be a non-empty subset of the venture's ENABLED stack
//    (venture_platforms) — posts never cross ventures, and a platform the
//    venture doesn't have can't be drafted into a post.
//  - youtube is refused this phase: it needs a per-post video and title,
//    and content_calendar only models kind='text' until the video phase.
//  - media URLs must be http(s) — Blotato fetches media by public URL.
//  - scheduledFor is accepted but informational ONLY: the approval gate is
//    the only path to publishing; nothing auto-publishes on a schedule.

export interface VenturePlatformRow {
  platform: string;
  blotato_account_id: string | null;
  blotato_page_id: string | null;
  youtube_privacy: string | null;
  enabled: boolean;
}

export interface SocialDraft {
  text: string;
  platforms: string[];
  mediaUrls: string[];
  scheduledFor: string | null;
}

export type DraftValidation = { ok: true; draft: SocialDraft } | { ok: false; error: string };

function invalid(error: string): DraftValidation {
  return { ok: false, error };
}

export function validateSocialDraft(body: unknown, stack: VenturePlatformRow[]): DraftValidation {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;

  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return invalid("text is required — the post body");

  if (!Array.isArray(b.platforms) || b.platforms.length === 0) {
    return invalid('platforms is required — a non-empty array, e.g. ["twitter","linkedin"]');
  }
  const platforms: string[] = [];
  for (const p of b.platforms) {
    if (typeof p !== "string" || !p.trim()) return invalid("every platform must be a non-empty string");
    if (!platforms.includes(p)) platforms.push(p);
  }
  if (platforms.includes("youtube")) {
    return invalid(
      "youtube needs a per-post video and title — video posts land in a later phase; " +
        "target twitter/linkedin for text posts",
    );
  }
  const enabled = new Set(stack.filter((r) => r.enabled).map((r) => r.platform));
  const outside = platforms.filter((p) => !enabled.has(p));
  if (outside.length > 0) {
    return invalid(
      `not in this venture's enabled platform stack: ${outside.join(", ")} — ` +
        "posts never cross ventures; add venture_platforms rows first if this is intentional",
    );
  }

  let mediaUrls: string[] = [];
  if (b.mediaUrls !== undefined) {
    if (!Array.isArray(b.mediaUrls)) return invalid("mediaUrls must be an array of URLs");
    for (const u of b.mediaUrls) {
      if (typeof u !== "string" || !/^https?:\/\//.test(u)) {
        return invalid("every mediaUrl must be a publicly accessible http(s) URL — Blotato fetches media by URL");
      }
    }
    mediaUrls = b.mediaUrls as string[];
  }

  let scheduledFor: string | null = null;
  if (b.scheduledFor !== undefined && b.scheduledFor !== null && b.scheduledFor !== "") {
    if (typeof b.scheduledFor !== "string" || Number.isNaN(Date.parse(b.scheduledFor))) {
      return invalid(
        "scheduledFor must be an ISO timestamp — and it is informational only this phase: " +
          "publishing happens on approval, never on a schedule",
      );
    }
    scheduledFor = new Date(b.scheduledFor).toISOString();
  }

  return { ok: true, draft: { text, platforms, mediaUrls, scheduledFor } };
}

// The exact proposals row the draft route files — exported for the payload
// shape test. text/platforms ride in the payload so the Slack approval
// prompt can show exactly what will be published; apply_proposal() reads
// only calendar_id (the calendar row is the record the approval flips).
export function socialProposalRow(args: { ventureId: string; calendarId: string; text: string; platforms: string[] }): {
  venture_id: string;
  action: "social.post";
  proposed_by: "admin";
  payload: { calendar_id: string; text: string; platforms: string[] };
} {
  return {
    venture_id: args.ventureId,
    action: "social.post",
    proposed_by: "admin",
    payload: { calendar_id: args.calendarId, text: args.text, platforms: args.platforms },
  };
}
