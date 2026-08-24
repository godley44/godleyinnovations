// Integration-shaped test of the framing call's REQUEST CONSTRUCTION against
// a mocked fetch — CI never hits the OpenAI API. Each test file runs in its
// own process under `node --test`, so swapping globalThis.fetch and the env
// here cannot leak into other suites.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FRAMING_MODEL, FRAMING_SYSTEM_PROMPT, frameForWhatsApp } from "./openai.js";

const realFetch = globalThis.fetch;
const TEST_KEY = "sk-test-key-not-real-123";

let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

beforeEach(() => {
  process.env.OPENAI_API_KEY = TEST_KEY;
  captured = null;
  nextResponse = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "  framed message  " } }] }), { status: 200 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
});

test("request: endpoint, method, auth header shape, model, message roles", async () => {
  const result = await frameForWhatsApp("BRIEF TEXT");
  assert.equal(result, "framed message", "content is returned trimmed");

  assert.ok(captured, "fetch was not called");
  assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured.init.method, "POST");

  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
  assert.match(headers["content-type"] ?? "", /application\/json/);

  const body = JSON.parse(String(captured.init.body)) as {
    model: string;
    max_tokens: number;
    messages: { role: string; content: string }[];
  };
  assert.equal(body.model, FRAMING_MODEL);
  assert.equal(body.model, "gpt-4o-mini");
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0, "a token cap must be set");
  assert.equal(body.messages.length, 2);
  assert.deepEqual(body.messages[0], { role: "system", content: FRAMING_SYSTEM_PROMPT });
  assert.deepEqual(body.messages[1], { role: "user", content: "BRIEF TEXT" });
  assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
});

test("system prompt carries the non-negotiables: no invented data, length cap, question, no tables", () => {
  assert.match(FRAMING_SYSTEM_PROMPT, /NEVER state a price.*not present in the source brief/s);
  assert.match(FRAMING_SYSTEM_PROMPT, /1200 characters/);
  assert.match(FRAMING_SYSTEM_PROMPT, /one engaging question/);
  assert.match(FRAMING_SYSTEM_PROMPT, /No tables/i);
  assert.match(FRAMING_SYSTEM_PROMPT, /Emoji: sparing — 2 to 4/);
});

test("API error surfaces OpenAI's message and status — never the key", async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 });
  await assert.rejects(frameForWhatsApp("brief"), (err: Error) => {
    assert.match(err.message, /HTTP 429: Rate limit reached/);
    assert.ok(!err.message.includes(TEST_KEY), "the API key must never appear in error messages");
    return true;
  });
});

test("empty completion is an error, not an empty proposal", async () => {
  nextResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
  await assert.rejects(frameForWhatsApp("brief"), /empty completion/);
});

test("missing key fails before any network call", async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(frameForWhatsApp("brief"), /OPENAI_API_KEY is not set/);
  assert.equal(captured, null, "no request may be attempted without a key");
});
