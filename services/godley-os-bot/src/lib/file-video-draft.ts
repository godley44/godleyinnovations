// THE video-draft code path — POST /admin/video-draft. Turns approved text
// into a spoken script (the framing agent, OpenRouter) and files it as a
// 'video.script' proposal on the existing approval rails. Nothing is
// narrated or rendered here: the script must be approved first, so no
// ElevenLabs or Pictory minutes are spent before the owner says yes. The
// approved script is picked up by the video_jobs ledger
// (src/lib/video-jobs.ts).
//
// Source text is either pasted (sourceText) or read from a calendar row
// (calendarId) of the SAME venture — a row from another venture is refused,
// never silently used.

import { writeVideoScript } from "../integrations/openai.js";
import { tableErrorMessage } from "./report-poller.js";
import { getSupabase } from "./supabase.js";
import {
  checkScript,
  validateVideoDraft,
  VIDEO_SCRIPT_SYSTEM_PROMPT,
  videoScriptProposalRow,
  type VenturePlatformRow,
  wordCount,
} from "./video-script.js";

const MIGRATION_008 = "008_video_pipeline.sql";
// The venture CTA when the ventures row has none — the script must still end
// on something the owner can read and change (ventures.video_cta).
const DEFAULT_CTA = "Follow for the next brief.";

export interface VideoDraftFiled {
  ok: true;
  proposalId: string;
  venture: string;
  title: string;
  platforms: string[];
  scriptWords: number;
  script: string;
  next: string;
}

export interface VideoDraftRefused {
  ok: false;
  status: number;
  error: string;
}

export async function fileVideoDraft(ventureSlug: string, body: unknown): Promise<VideoDraftFiled | VideoDraftRefused> {
  const supabase = getSupabase();
  const { data: venture, error: ventureError } = await supabase
    .from("ventures")
    .select("id, name, slug, video_cta")
    .eq("slug", ventureSlug)
    .maybeSingle();
  if (ventureError) {
    return {
      ok: false,
      status: 500,
      error: tableErrorMessage(ventureError.message, ventureError.code, "ventures", MIGRATION_008),
    };
  }
  if (!venture) return { ok: false, status: 404, error: `no venture with slug "${ventureSlug}"` };
  const v = venture as { id: string; name: string; video_cta: unknown };
  const cta = typeof v.video_cta === "string" && v.video_cta.trim() ? v.video_cta.trim() : DEFAULT_CTA;

  const { data: stackData, error: stackError } = await supabase
    .from("venture_platforms")
    .select("platform, enabled")
    .eq("venture_id", v.id);
  if (stackError) {
    return {
      ok: false,
      status: 500,
      error: tableErrorMessage(stackError.message, stackError.code, "venture_platforms", "007_social_publishing.sql"),
    };
  }
  const stack = (stackData ?? []).flatMap((raw): VenturePlatformRow[] => {
    const d = raw as Record<string, unknown>;
    return typeof d.platform === "string" ? [{ platform: d.platform, enabled: d.enabled === true }] : [];
  });

  const validated = validateVideoDraft(body, stack);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const draft = validated.draft;

  let sourceText = draft.sourceText ?? "";
  if (draft.calendarId) {
    const { data: cal, error: calError } = await supabase
      .from("content_calendar")
      .select("id, venture_id, body")
      .eq("id", draft.calendarId)
      .maybeSingle();
    if (calError) {
      return { ok: false, status: 500, error: tableErrorMessage(calError.message, calError.code, "content_calendar", "007_social_publishing.sql") };
    }
    const row = cal as { venture_id?: unknown; body?: unknown } | null;
    if (!row) return { ok: false, status: 404, error: `no content_calendar row ${draft.calendarId}` };
    if (row.venture_id !== v.id) {
      return { ok: false, status: 400, error: "that calendar row belongs to another venture — posts never cross ventures" };
    }
    sourceText = typeof row.body === "string" ? row.body.trim() : "";
    if (!sourceText) return { ok: false, status: 400, error: "that calendar row has no text to narrate" };
  }

  let raw: string;
  try {
    raw = await writeVideoScript({ system: VIDEO_SCRIPT_SYSTEM_PROMPT, sourceText, cta });
  } catch (err) {
    return { ok: false, status: 502, error: `the script agent failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const checked = checkScript(raw, cta);
  if (!checked.ok) {
    return { ok: false, status: 502, error: `the script agent's output was refused: ${checked.error} — retry the draft` };
  }

  const { data: propRow, error: propError } = await supabase
    .from("proposals")
    .insert(
      videoScriptProposalRow({
        ventureId: v.id,
        script: checked.script,
        title: draft.title,
        platforms: draft.platforms,
        cta,
        sourceCalendarId: draft.calendarId,
        sourceText,
      }),
    )
    .select("id")
    .single();
  if (propError || !propRow) {
    const hint = /proposals_action_check/.test(propError?.message ?? "") ? ` — run supabase/migrations/${MIGRATION_008} (the action whitelist part)` : "";
    return { ok: false, status: 500, error: `filing the video.script proposal failed: ${propError?.message ?? "no row returned"}${hint}` };
  }

  return {
    ok: true,
    proposalId: (propRow as { id: string }).id,
    venture: ventureSlug,
    title: draft.title,
    platforms: draft.platforms,
    scriptWords: wordCount(checked.script),
    script: checked.script,
    next:
      "approve the script via the Slack buttons or the app inbox — only then does the bot narrate (ElevenLabs) and " +
      "assemble (Pictory) the video, which comes back as its own social.post proposal with a preview link",
  };
}
