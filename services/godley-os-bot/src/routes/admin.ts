// Admin routes — the owner's manual entry points, curl-sized:
//
//   POST /admin/deliver-now       — run ONE real poll cycle now (delivery,
//                                   framing, prompts, disarm, publish,
//                                   confirm) and return the per-item outcome
//                                   as JSON, so the pipeline can be tested
//                                   without waiting on the Monday cron.
//   POST /admin/social-draft      — file a social post: creates the
//                                   content_calendar row and its
//                                   'social.post' proposal, which then rides
//                                   the EXISTING approval rails (Slack
//                                   buttons / app inbox). Drafting never
//                                   publishes; only approval does.
//   GET  /admin/blotato-accounts  — list the Blotato accounts behind the
//                                   real API key, for assigning
//                                   venture_platforms.blotato_account_id at
//                                   live-test time. Read-only; refuses with
//                                   a clear message while the key is the
//                                   placeholder.
//
// Auth on every route: Authorization: Bearer <ADMIN_SECRET>. Fail closed —
// with the secret unset every request is refused, so a fresh deploy can
// never expose the routes by accident. Unlike the Slack routes there is no
// 3-second rule here (the caller is the owner with curl, not Slack), so
// handlers await their real work and answer with the real result.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { isDryRun, listAccounts } from "../integrations/blotato.js";
import { runPollCycle, tableErrorMessage } from "../lib/report-poller.js";
import { socialProposalRow, validateSocialDraft, type VenturePlatformRow } from "../lib/social-draft.js";
import { getSupabase } from "../lib/supabase.js";

// Hash both sides so the comparison is timing-safe without leaking length.
function secretsEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Returns the refusal response, or null when the caller is the owner.
function requireAdmin(c: Context): Response | null {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return c.json({ ok: false, error: "ADMIN_SECRET is not set — admin routes are disabled" }, 503);
  }
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!presented || !secretsEqual(presented, secret)) {
    return c.json({ ok: false, error: "bad or missing admin secret" }, 401);
  }
  return null;
}

export const adminRoutes = new Hono();

adminRoutes.post("/deliver-now", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const result = await runPollCycle();
  if (result.skipped) {
    return c.json({ ok: false, error: "a poll cycle is already running — retry in a few seconds" }, 409);
  }
  return c.json({
    ok: result.state.lastCheckOk === true,
    checkedAt: result.state.lastCheckAt,
    error: result.state.lastCheckError,
    deliveries: result.state.lastDeliveries,
    prompts: result.state.lastPrompts,
    framings: result.state.lastFramings,
    publishes: result.state.lastPublishes,
  });
});

adminRoutes.post("/social-draft", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body must be JSON" }, 400);
  }
  const ventureSlug =
    typeof (body as Record<string, unknown> | null)?.ventureSlug === "string"
      ? ((body as Record<string, unknown>).ventureSlug as string).trim()
      : "";
  if (!ventureSlug) {
    return c.json({ ok: false, error: 'ventureSlug is required, e.g. "lil-bull"' }, 400);
  }

  const supabase = getSupabase();
  const { data: venture, error: ventureError } = await supabase
    .from("ventures")
    .select("id, name, slug")
    .eq("slug", ventureSlug)
    .maybeSingle();
  if (ventureError) {
    return c.json({ ok: false, error: `ventures query failed: ${ventureError.message}` }, 500);
  }
  if (!venture) {
    return c.json({ ok: false, error: `no venture with slug "${ventureSlug}"` }, 404);
  }
  const ventureId = (venture as { id: string }).id;

  const { data: stackData, error: stackError } = await supabase
    .from("venture_platforms")
    .select("platform, blotato_account_id, blotato_page_id, youtube_privacy, enabled")
    .eq("venture_id", ventureId);
  if (stackError) {
    return c.json(
      { ok: false, error: tableErrorMessage(stackError.message, stackError.code, "venture_platforms", "007_social_publishing.sql") },
      500,
    );
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
    return c.json({ ok: false, error: validated.error }, 400);
  }
  const draft = validated.draft;

  const { data: calRow, error: calError } = await supabase
    .from("content_calendar")
    .insert({
      venture_id: ventureId,
      body: draft.text,
      media_urls: draft.mediaUrls,
      platforms: draft.platforms,
      scheduled_for: draft.scheduledFor,
      status: "draft",
    })
    .select("id")
    .single();
  if (calError || !calRow) {
    return c.json(
      {
        ok: false,
        error: tableErrorMessage(
          calError?.message ?? "no row returned",
          calError?.code,
          "content_calendar",
          "007_social_publishing.sql",
        ),
      },
      500,
    );
  }
  const calendarId = (calRow as { id: string }).id;

  const { data: propRow, error: propError } = await supabase
    .from("proposals")
    .insert(socialProposalRow({ ventureId, calendarId, text: draft.text, platforms: draft.platforms }))
    .select("id")
    .single();
  if (propError || !propRow) {
    const hint = /proposals_action_check/.test(propError?.message ?? "")
      ? " — run supabase/migrations/007_social_publishing.sql (the action whitelist part)"
      : "";
    return c.json(
      {
        ok: false,
        error:
          `filing the social.post proposal failed: ${propError?.message ?? "no row returned"}${hint}. ` +
          `The calendar row ${calendarId} stays 'draft' (harmless) — retry after fixing the cause.`,
      },
      500,
    );
  }
  const proposalId = (propRow as { id: string }).id;

  const { error: wireError } = await supabase
    .from("content_calendar")
    .update({ status: "proposed", proposal_id: proposalId, updated_at: new Date().toISOString() })
    .eq("id", calendarId)
    .eq("status", "draft");
  if (wireError) {
    return c.json(
      {
        ok: false,
        error:
          `proposal ${proposalId} was filed but wiring it to calendar row ${calendarId} failed: ${wireError.message}. ` +
          "Approving now would raise ('no matching proposed calendar row') — reject the proposal, then retry the draft.",
      },
      500,
    );
  }

  return c.json({
    ok: true,
    calendarId,
    proposalId,
    venture: ventureSlug,
    platforms: draft.platforms,
    scheduledFor: draft.scheduledFor,
    dryRun: isDryRun(),
    next:
      "approve it via the Slack buttons or the app inbox — the poller publishes within a cycle of approval" +
      (isDryRun() ? " (dry-run mode: the exact requests are logged, nothing reaches Blotato)" : ""),
  });
});

adminRoutes.get("/blotato-accounts", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  try {
    const accounts = await listAccounts();
    return c.json({
      ok: true,
      accounts,
      hint:
        "assign in the Supabase SQL editor: update venture_platforms set blotato_account_id = '<id>' " +
        "where venture_id = (select id from ventures where slug = '<slug>') and platform = '<platform>';",
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 409);
  }
});
