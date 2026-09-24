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
//   GET  /admin/blotato-accounts?venture=<slug>
//                                 — list the Blotato accounts (and Facebook
//                                   Pages) behind THAT venture's key
//                                   (BLOTATO_API_KEY__<SLUG>; lil-bull falls
//                                   back to BLOTATO_API_KEY). Read-only;
//                                   refuses with a clear message while the
//                                   key is missing or the placeholder.
//   POST /admin/blotato-accounts/sync { "ventureSlug" }
//                                 — upsert the venture's Instagram +
//                                   Facebook venture_platforms rows from
//                                   that listing (shared with the manager's
//                                   "sync blotato accounts for <slug>").
//                                   Internal config, not an external write.
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
import { listAccounts, listSubaccounts, LEGACY_SHARED_KEY_SLUG } from "../integrations/blotato.js";
import { syncBlotatoAccounts } from "../lib/blotato-sync.js";
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
  // The venture whose key to use. Unnamed = the legacy shared key's venture,
  // so the pre-008 call keeps working.
  const ventureSlug = (c.req.query("venture") ?? LEGACY_SHARED_KEY_SLUG).trim();
  if (!/^[a-z0-9-]+$/.test(ventureSlug)) return c.json({ ok: false, error: "venture must be a slug, e.g. couplestherapy101" }, 400);
  try {
    const accounts = await listAccounts(ventureSlug);
    // Facebook (and LinkedIn) publish to a Page, which is a subaccount.
    const withPages = [];
    for (const a of accounts) {
      const platform = a.platform.toLowerCase();
      if (platform !== "facebook" && platform !== "linkedin") {
        withPages.push(a);
        continue;
      }
      try {
        withPages.push({ ...a, pages: await listSubaccounts(ventureSlug, a.id) });
      } catch (err) {
        withPages.push({ ...a, pagesError: err instanceof Error ? err.message : String(err) });
      }
    }
    return c.json({
      ok: true,
      venture: ventureSlug,
      accounts: withPages,
      hint: `POST /admin/blotato-accounts/sync {"ventureSlug":"${ventureSlug}"} writes the Instagram + Facebook rows — or say "sync blotato accounts for ${ventureSlug}" in #studio-admin`,
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

adminRoutes.post("/blotato-accounts/sync", async (c) => {
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
  if (!/^[a-z0-9-]+$/.test(ventureSlug)) {
    return c.json({ ok: false, error: 'ventureSlug is required, e.g. "couplestherapy101"' }, 400);
  }
  const result = await syncBlotatoAccounts(ventureSlug);
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.status as 404 | 409 | 500 | 502);
  return c.json(result);
});
