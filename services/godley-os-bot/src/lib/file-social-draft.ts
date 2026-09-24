// THE social-draft code path — files a content_calendar row plus its
// 'social.post' proposal, extracted from src/routes/admin.ts so the AI
// Manager's create_social_draft action, POST /admin/social-draft, and the
// content agent's file_for_approval run literally the same function.
// Drafting never publishes: the proposal it files still rides the existing
// approval rails (Slack buttons / app inbox / manager), and only approval
// publishes.

import { isDryRun } from "../integrations/blotato.js";
import { tableErrorMessage } from "./report-poller.js";
import { socialProposalRow, validateSocialDraft, type VenturePlatformRow } from "./social-draft.js";
import { getSupabase } from "./supabase.js";

export interface SocialDraftFiled {
  ok: true;
  calendarId: string;
  proposalId: string;
  venture: string;
  platforms: string[];
  scheduledFor: string | null;
  dryRun: boolean;
  next: string;
}

export interface SocialDraftRefused {
  ok: false;
  status: number; // the HTTP status the admin route answers with
  error: string;
}

// The content agent's additions; every field optional so the text-post
// callers are unchanged.
export interface FileSocialDraftOptions {
  kind?: "text" | "image";
  contentItemId?: string;
  captions?: Record<string, string>; // per venture slug, stored on the calendar row for the executor
  proposedBy?: string;
  payloadExtras?: Record<string, unknown>; // rendered by the approval surfaces
}

export async function fileSocialDraft(
  ventureSlug: string,
  body: unknown,
  options: FileSocialDraftOptions = {},
): Promise<SocialDraftFiled | SocialDraftRefused> {
  const supabase = getSupabase();
  const { data: venture, error: ventureError } = await supabase
    .from("ventures")
    .select("id, name, slug")
    .eq("slug", ventureSlug)
    .maybeSingle();
  if (ventureError) {
    return { ok: false, status: 500, error: `ventures query failed: ${ventureError.message}` };
  }
  if (!venture) {
    return { ok: false, status: 404, error: `no venture with slug "${ventureSlug}"` };
  }
  const ventureId = (venture as { id: string }).id;

  const { data: stackData, error: stackError } = await supabase
    .from("venture_platforms")
    .select("platform, blotato_account_id, blotato_page_id, youtube_privacy, enabled")
    .eq("venture_id", ventureId);
  if (stackError) {
    return {
      ok: false,
      status: 500,
      error: tableErrorMessage(stackError.message, stackError.code, "venture_platforms", "007_social_publishing.sql"),
    };
  }
  const stack = (stackData ?? []).flatMap((raw): VenturePlatformRow[] => {
    const d = raw as Record<string, unknown>;
    return typeof d.platform === "string"
      ? [
          {
            platform: d.platform,
            blotato_account_id: typeof d.blotato_account_id === "string" ? d.blotato_account_id : null,
            blotato_page_id: typeof d.blotato_page_id === "string" ? d.blotato_page_id : null,
            youtube_privacy: typeof d.youtube_privacy === "string" ? d.youtube_privacy : null,
            enabled: d.enabled === true,
          },
        ]
      : [];
  });

  const validated = validateSocialDraft(body, stack);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error };
  }
  const draft = validated.draft;

  const { data: calRow, error: calError } = await supabase
    .from("content_calendar")
    .insert({
      venture_id: ventureId,
      kind: options.kind ?? "text",
      body: draft.text,
      media_urls: draft.mediaUrls,
      platforms: draft.platforms,
      scheduled_for: draft.scheduledFor,
      status: "draft",
      ...(options.contentItemId ? { content_item_id: options.contentItemId } : {}),
      ...(options.captions ? { captions: options.captions } : {}),
    })
    .select("id")
    .single();
  if (calError || !calRow) {
    return {
      ok: false,
      status: 500,
      error: tableErrorMessage(
        calError?.message ?? "no row returned",
        calError?.code,
        "content_calendar",
        options.kind === "image" ? "009_content_items.sql" : "007_social_publishing.sql",
      ),
    };
  }
  const calendarId = (calRow as { id: string }).id;

  const { data: propRow, error: propError } = await supabase
    .from("proposals")
    .insert(
      socialProposalRow({
        ventureId,
        calendarId,
        text: draft.text,
        platforms: draft.platforms,
        proposedBy: options.proposedBy,
        extras: {
          ...(draft.mediaUrls.length > 0 ? { mediaUrls: draft.mediaUrls } : {}),
          ...(options.payloadExtras ?? {}),
        },
      }),
    )
    .select("id")
    .single();
  if (propError || !propRow) {
    const hint = /proposals_action_check/.test(propError?.message ?? "")
      ? " — run supabase/migrations/007_social_publishing.sql (the action whitelist part)"
      : "";
    return {
      ok: false,
      status: 500,
      error:
        `filing the social.post proposal failed: ${propError?.message ?? "no row returned"}${hint}. ` +
        `The calendar row ${calendarId} stays 'draft' (harmless) — retry after fixing the cause.`,
    };
  }
  const proposalId = (propRow as { id: string }).id;

  const { error: wireError } = await supabase
    .from("content_calendar")
    .update({ status: "proposed", proposal_id: proposalId, updated_at: new Date().toISOString() })
    .eq("id", calendarId)
    .eq("status", "draft");
  if (wireError) {
    return {
      ok: false,
      status: 500,
      error:
        `proposal ${proposalId} was filed but wiring it to calendar row ${calendarId} failed: ${wireError.message}. ` +
        "Approving now would raise ('no matching proposed calendar row') — reject the proposal, then retry the draft.",
    };
  }

  const dryRun = isDryRun(ventureSlug);
  return {
    ok: true,
    calendarId,
    proposalId,
    venture: ventureSlug,
    platforms: draft.platforms,
    scheduledFor: draft.scheduledFor,
    dryRun,
    next:
      "approve it via the Slack buttons or the app inbox — the poller publishes within a cycle of approval" +
      (dryRun ? " (dry-run mode: the exact requests are logged, nothing reaches Blotato)" : ""),
  };
}
