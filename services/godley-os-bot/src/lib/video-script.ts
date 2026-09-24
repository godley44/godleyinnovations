// Pure rules for the video pipeline's first half — the SPOKEN SCRIPT:
//  - the TUNE ME prompt the framing agent rewrites source text with;
//  - validation of POST /admin/video-draft (before anything is spent);
//  - the exact 'video.script' proposal row and the checks on the model's
//    output.
// Kept free of I/O so every rule is unit-testable; src/lib/file-video-draft.ts
// owns the database and model calls.
//
// Money order: the script is its own approval (video.script) BEFORE any
// narration or rendering minutes are spent. Only an approved script reaches
// the video_jobs ledger.

// ---------------------------------------------------------------------------
// TUNE ME: the video narrator's voice. Edit freely — nothing else depends on
// the wording, only on the data-invention ban, the length band, the single
// takeaway, and the closing call-to-action (which is appended verbatim by the
// user turn, see writeVideoScript in src/integrations/openai.ts).
// ---------------------------------------------------------------------------
export const VIDEO_SCRIPT_SYSTEM_PROMPT = `You write the spoken script for a short vertical video (45 to 90 seconds when read aloud, about 110 to 230 words) narrated by the venture's founder in their own voice.

Rules:
- Conversational, first person, like talking to a friend who follows the markets. Short sentences. No headings, no bullet points, no emojis, no stage directions, no "[pause]" markers — plain spoken sentences only, because every word is read aloud exactly as written.
- ONE takeaway. Open with it in the first sentence, explain it, then close.
- Every number, price, level, percentage, date, indicator reading, or calendar item MUST come from the SOURCE TEXT. NEVER state a market number or fact that is not present in it. If the source lacks a value, talk around it — do not invent one.
- Keep any "data unavailable" caveat from the source, briefly.
- The final line is the CALL TO ACTION given to you, spoken verbatim, nothing after it.
- Output the script only: no title, no preamble, no quotes around it.`;

// Spoken-length band, in words — the prompt's 45–90 seconds at a natural
// ~150 wpm, with tolerance for the model.
export const SCRIPT_MIN_WORDS = 80;
export const SCRIPT_MAX_WORDS = 300;
// YouTube's title limit.
export const TITLE_MAX_CHARS = 100;
// The platforms a video can target this phase (Blotato video targets the
// client models; text platforms stay text-only).
export const VIDEO_PLATFORMS: readonly string[] = ["youtube", "instagram"];

export interface VenturePlatformRow {
  platform: string;
  enabled: boolean;
}

export interface VideoDraft {
  title: string;
  platforms: string[];
  // Exactly one of the two: pasted text, or the calendar row to read it from.
  sourceText: string | null;
  calendarId: string | null;
}

export type VideoDraftValidation = { ok: true; draft: VideoDraft } | { ok: false; error: string };

function invalid(error: string): VideoDraftValidation {
  return { ok: false, error };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateVideoDraft(body: unknown, stack: VenturePlatformRow[]): VideoDraftValidation {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;

  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return invalid("title is required — the YouTube title of the video");
  if (title.length > TITLE_MAX_CHARS) return invalid(`title is longer than ${TITLE_MAX_CHARS} characters (YouTube's limit)`);

  const sourceText = typeof b.sourceText === "string" ? b.sourceText.trim() : "";
  const calendarId = typeof b.calendarId === "string" ? b.calendarId.trim() : "";
  if (!sourceText && !calendarId) return invalid("sourceText (the approved text to narrate) or calendarId (a calendar row to read it from) is required");
  if (sourceText && calendarId) return invalid("give sourceText OR calendarId, not both");
  if (calendarId && !UUID_RE.test(calendarId)) return invalid("calendarId must be a content_calendar uuid");

  if (!Array.isArray(b.platforms) || b.platforms.length === 0) {
    return invalid('platforms is required — a non-empty array, e.g. ["youtube"]');
  }
  const platforms: string[] = [];
  for (const p of b.platforms) {
    if (typeof p !== "string" || !p.trim()) return invalid("every platform must be a non-empty string");
    if (!platforms.includes(p)) platforms.push(p);
  }
  const notVideo = platforms.filter((p) => !VIDEO_PLATFORMS.includes(p));
  if (notVideo.length > 0) {
    return invalid(`video posts target ${VIDEO_PLATFORMS.join("/")} only this phase — not ${notVideo.join(", ")}`);
  }
  const enabled = new Set(stack.filter((r) => r.enabled).map((r) => r.platform));
  const outside = platforms.filter((p) => !enabled.has(p));
  if (outside.length > 0) {
    return invalid(
      `not in this venture's enabled platform stack: ${outside.join(", ")} — ` +
        "posts never cross ventures; connect the account in Blotato and enable its venture_platforms row first",
    );
  }

  return { ok: true, draft: { title, platforms, sourceText: sourceText || null, calendarId: calendarId || null } };
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// The model's output, checked against the prompt's non-negotiables before it
// is filed. Returns the cleaned script or the reason it was refused.
export function checkScript(raw: string, cta: string): { ok: true; script: string } | { ok: false; error: string } {
  const script = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!script) return { ok: false, error: "the model returned an empty script" };
  const words = wordCount(script);
  if (words < SCRIPT_MIN_WORDS) return { ok: false, error: `the script is ${words} words — under the ${SCRIPT_MIN_WORDS}-word floor` };
  if (words > SCRIPT_MAX_WORDS) return { ok: false, error: `the script is ${words} words — over the ${SCRIPT_MAX_WORDS}-word cap` };
  const normalize = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalize(script).endsWith(normalize(cta))) {
    return { ok: false, error: "the script does not end with the venture's call to action" };
  }
  if (/^\s*[-*#]/m.test(script) || /[\u{1F300}-\u{1FAFF}]/u.test(script)) {
    return { ok: false, error: "the script contains list markers, headings, or emojis — spoken sentences only" };
  }
  return { ok: true, script };
}

// The exact proposals row the draft route files. script/title/platforms
// ride in the payload so the approval prompt shows exactly what will be
// narrated; apply_proposal() writes nothing for this action (approving is
// the go signal for the video_jobs ledger).
export interface VideoScriptPayload {
  script: string;
  title: string;
  platforms: string[];
  cta: string;
  source_calendar_id: string | null;
  source_preview: string;
}

export function videoScriptProposalRow(args: {
  ventureId: string;
  script: string;
  title: string;
  platforms: string[];
  cta: string;
  sourceCalendarId: string | null;
  sourceText: string;
}): { venture_id: string; action: "video.script"; proposed_by: "video-agent"; payload: VideoScriptPayload } {
  const preview = args.sourceText.replace(/\s+/g, " ").trim();
  return {
    venture_id: args.ventureId,
    action: "video.script",
    proposed_by: "video-agent",
    payload: {
      script: args.script,
      title: args.title,
      platforms: args.platforms,
      cta: args.cta,
      source_calendar_id: args.sourceCalendarId,
      source_preview: preview.length <= 200 ? preview : `${preview.slice(0, 199).trimEnd()}…`,
    },
  };
}

// The approved script payload, re-read by the video step. Defensive: the
// payload is JSON from the database, never trusted blindly.
export function readVideoScriptPayload(raw: unknown): VideoScriptPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.script !== "string" || !p.script.trim()) return null;
  if (typeof p.title !== "string" || !p.title.trim()) return null;
  const platforms = Array.isArray(p.platforms) ? p.platforms.filter((x): x is string => typeof x === "string") : [];
  if (platforms.length === 0) return null;
  return {
    script: p.script,
    title: p.title,
    platforms,
    cta: typeof p.cta === "string" ? p.cta : "",
    source_calendar_id: typeof p.source_calendar_id === "string" ? p.source_calendar_id : null,
    source_preview: typeof p.source_preview === "string" ? p.source_preview : "",
  };
}
