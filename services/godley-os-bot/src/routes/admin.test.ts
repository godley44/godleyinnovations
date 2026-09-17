// Tests for POST /admin/notify: fail-closed auth, body validation, the
// #studio-admin post itself (Slack stubbed at the fetch boundary), and the
// redaction rule — no secret ever appears in a response body.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { adminRoutes, STUDIO_ADMIN_CHANNEL } from "./admin.js";

const ADMIN_SECRET = "test-admin-secret-9f8e7d";
const BOT_TOKEN = "xoxb-test-bot-token-1a2b3c";

interface SlackCall {
  method: string;
  form: URLSearchParams;
  authorization: string | null;
}
const slackCalls: SlackCall[] = [];
const realFetch = globalThis.fetch;

before(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.replace("https://slack.com/api/", "");
    const headers = new Headers(init?.headers);
    slackCalls.push({ method, form: new URLSearchParams(String(init?.body ?? "")), authorization: headers.get("authorization") });
    if (method === "conversations.list") {
      return Response.json({
        ok: true,
        channels: [
          { id: "C1", name: "lil-bull", is_member: true },
          { id: "C2", name: STUDIO_ADMIN_CHANNEL, is_member: true },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "chat.postMessage") return Response.json({ ok: true, ts: "1700000000.000100" });
    return Response.json({ ok: false, error: `unexpected method ${method}` });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

async function notify(body: unknown, secret: string | null = ADMIN_SECRET): Promise<Response> {
  return await adminRoutes.request("/notify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function assertRedacted(payload: unknown): void {
  const s = JSON.stringify(payload);
  assert.ok(!s.includes(ADMIN_SECRET), "response leaks ADMIN_SECRET");
  assert.ok(!s.includes(BOT_TOKEN), "response leaks SLACK_BOT_TOKEN");
}

test("refuses with 401 on a wrong or missing secret", async () => {
  const wrong = await notify({ text: "hi" }, "not-the-secret");
  assert.equal(wrong.status, 401);
  assertRedacted(await wrong.json());
  const missing = await notify({ text: "hi" }, null);
  assert.equal(missing.status, 401);
  assert.equal(slackCalls.length, 0, "nothing reaches Slack without auth");
});

test("fails closed with 503 while ADMIN_SECRET is unset", async () => {
  const saved = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  try {
    const res = await notify({ text: "hi" });
    assert.equal(res.status, 503);
    assertRedacted(await res.json());
  } finally {
    process.env.ADMIN_SECRET = saved;
  }
});

test("validates the body", async () => {
  assert.equal((await notify("not json")).status, 400);
  assert.equal((await notify({})).status, 400);
  assert.equal((await notify({ text: "   " })).status, 400);
  assert.equal((await notify({ text: "x".repeat(4001) })).status, 400);
  assert.equal((await notify({ text: "hi", level: "loud" })).status, 400);
  assert.equal(slackCalls.length, 0);
});

test("posts to #studio-admin with the level prefix and answers with the message ts", async () => {
  const res = await notify({ text: "Deployed abc1234 · migrations: none", level: "info" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; channel: string; ts: string };
  assert.deepEqual(body, { ok: true, channel: STUDIO_ADMIN_CHANNEL, ts: "1700000000.000100" });
  assertRedacted(body);

  const post = slackCalls.find((c) => c.method === "chat.postMessage");
  assert.ok(post, "chat.postMessage was called");
  assert.equal(post.form.get("channel"), "C2");
  assert.equal(post.form.get("text"), "🚀 Deployed abc1234 · migrations: none");
  assert.equal(post.authorization, `Bearer ${BOT_TOKEN}`);

  const failure = await notify({ text: "DEPLOY FAILED at step migrations", level: "error" });
  assert.equal(failure.status, 200);
  const last = slackCalls.at(-1)!;
  assert.equal(last.form.get("text"), "🚨 DEPLOY FAILED at step migrations");
});
