// Slack request verification, implemented by hand (no Slack SDK) per
// https://api.slack.com/authentication/verifying-requests-from-slack:
// HMAC SHA-256 of "v0:<timestamp>:<raw body>" with the app's signing secret,
// compared timing-safe against the x-slack-signature header. Requests older
// than five minutes are rejected so a captured request can't be replayed.
//
// The middleware runs on BOTH Slack routes and stores the raw body in the
// context for handlers — the signature is computed over the exact bytes
// Slack sent, so nothing may parse the body before this runs.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

// Hono context variables that slackVerify sets for downstream handlers.
export type SlackVerifiedEnv = { Variables: { rawBody: string } };

const MAX_AGE_SECONDS = 60 * 5;

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    // Refuse everything rather than run unverified.
    console.error("SLACK_SIGNING_SECRET is not set — rejecting all Slack requests");
    return false;
  }
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_AGE_SECONDS) return false;

  const expected =
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const slackVerify: MiddlewareHandler<SlackVerifiedEnv> = async (c, next) => {
  const rawBody = await c.req.text();
  const ok = verifySlackSignature(
    rawBody,
    c.req.header("x-slack-request-timestamp"),
    c.req.header("x-slack-signature"),
  );
  if (!ok) return c.text("invalid signature", 401);
  c.set("rawBody", rawBody);
  await next();
};
