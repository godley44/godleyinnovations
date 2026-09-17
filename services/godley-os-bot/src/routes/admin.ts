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
//   POST /admin/notify            — post one line to #studio-admin (the
//                                   owner's console). Called by the
//                                   deploy-on-main workflow with the deploy
//                                   outcome. Slack is the workroom, not an
//                                   external platform, so this is not gated;
//                                   it never touches the database.
//
// Auth on every route: Authorization: Bearer <ADMIN_SECRET>. Fail closed —
// with the secret unset every request is refused, so a fresh deploy can
// never expose the routes by accident. Unlike the Slack routes there is no
// 3-second rule here (the caller is the owner with curl, not Slack), so
// handlers await their real work and answer with the real result.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { listAccounts } from "../integrations/blotato.js";
import { fileSocialDraft } from "../lib/file-social-draft.js";
import { runPollCycle } from "../lib/report-poller.js";
import { listChannelsByName, postMessage } from "../lib/slack-web.js";

// The owner's console channel. Not a venture (no ventures row), so it is
// named here rather than resolved through venture-map.
export const STUDIO_ADMIN_CHANNEL = "studio-admin";
const NOTIFY_MAX_CHARS = 4000;

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

  // The draft logic lives in src/lib/file-social-draft.ts — shared verbatim
  // with the AI Manager's create_social_draft action.
  const result = await fileSocialDraft(ventureSlug, body);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, result.status as 400 | 404 | 500);
  }
  return c.json(result);
});

adminRoutes.post("/notify", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body must be JSON" }, 400);
  }
  const fields = (body ?? {}) as Record<string, unknown>;
  const text = typeof fields.text === "string" ? fields.text.trim() : "";
  if (!text) return c.json({ ok: false, error: "text is required" }, 400);
  if (text.length > NOTIFY_MAX_CHARS) {
    return c.json({ ok: false, error: `text is longer than ${NOTIFY_MAX_CHARS} characters` }, 400);
  }
  const level = fields.level === undefined || fields.level === "info" ? "info" : fields.level === "error" ? "error" : null;
  if (level === null) return c.json({ ok: false, error: 'level must be "info" or "error"' }, 400);

  let channels: Awaited<ReturnType<typeof listChannelsByName>>;
  try {
    channels = await listChannelsByName();
  } catch (err) {
    return c.json({ ok: false, error: `Slack channel lookup failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  const channel = channels.get(STUDIO_ADMIN_CHANNEL);
  if (!channel) {
    return c.json({ ok: false, error: `no public channel named #${STUDIO_ADMIN_CHANNEL} — create it and invite the bot` }, 502);
  }
  if (!channel.isMember) {
    return c.json({ ok: false, error: `the bot is not a member of #${STUDIO_ADMIN_CHANNEL} — run /invite @<bot> there` }, 502);
  }

  try {
    const ts = await postMessage({ channel: channel.id, text: `${level === "error" ? "🚨" : "🚀"} ${text}` });
    return c.json({ ok: true, channel: channel.name, ts });
  } catch (err) {
    return c.json({ ok: false, error: `Slack refused the post: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
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
