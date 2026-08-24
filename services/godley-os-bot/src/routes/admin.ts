// POST /admin/deliver-now — manual poll trigger so delivery can be tested
// end-to-end without waiting for Monday's cron. Runs ONE real delivery
// cycle and returns the per-report outcome as JSON.
//
// Auth: Authorization: Bearer <ADMIN_SECRET>. Fail closed — with the secret
// unset every request is refused, so a fresh deploy can never expose the
// route by accident. Unlike the Slack routes there is no 3-second rule here
// (the caller is the owner with curl, not Slack), so the cycle is awaited
// and the response carries its real result.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { runPollCycle } from "../lib/report-poller.js";

// Hash both sides so the comparison is timing-safe without leaking length.
function secretsEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const adminRoutes = new Hono();

adminRoutes.post("/deliver-now", async (c) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return c.json({ ok: false, error: "ADMIN_SECRET is not set — admin routes are disabled" }, 503);
  }
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!presented || !secretsEqual(presented, secret)) {
    return c.json({ ok: false, error: "bad or missing admin secret" }, 401);
  }

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
  });
});
