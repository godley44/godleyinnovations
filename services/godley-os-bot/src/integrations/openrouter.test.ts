// The shared OpenRouter client: provider resolution and the REQUEST /
// RESPONSE contract against a mocked fetch — CI never hits OpenRouter. Each
// test file runs in its own process under `node --test`, so swapping
// globalThis.fetch and the env here cannot leak into other suites.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chatCompletion, OPENROUTER_URL, resolveAiProvider } from "./openrouter.js";

const realFetch = globalThis.fetch;
const TEST_KEY = "sk-or-v1-test-key-not-real-123";

let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function resetEnv(): void {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

beforeEach(() => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = TEST_KEY;
  captured = null;
  nextResponse = () =>
    apiResponse({
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEnv();
});

// --- provider resolution ------------------------------------------------------

test("AI_PROVIDER unset + OPENROUTER_API_KEY set → openrouter", () => {
  assert.equal(resolveAiProvider(), "openrouter");
});

test("AI_PROVIDER unset + no OpenRouter key → direct (the transition default, warned)", () => {
  delete process.env.OPENROUTER_API_KEY;
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: unknown) => warnings.push(String(msg));
  try {
    assert.equal(resolveAiProvider(), "direct");
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /OPENROUTER_API_KEY is not set/);
});

test("AI_PROVIDER=direct wins even with an OpenRouter key", () => {
  process.env.AI_PROVIDER = "direct";
  assert.equal(resolveAiProvider(), "direct");
});

test("AI_PROVIDER=openrouter is honoured (case-insensitive) and an unknown value is refused", () => {
  process.env.AI_PROVIDER = "OpenRouter";
  assert.equal(resolveAiProvider(), "openrouter");
  process.env.AI_PROVIDER = "azure";
  assert.throws(() => resolveAiProvider(), /AI_PROVIDER must be "openrouter" or "direct"/);
});

// --- request contract ----------------------------------------------------------

test("request: endpoint, bearer auth, attribution headers, body fields, tools passed through", async () => {
  const reply = await chatCompletion({
    model: "anthropic/claude-haiku-4.5",
    messages: [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "hi" },
    ],
    maxTokens: 512,
    tools: [{ type: "function", function: { name: "health", description: "d", parameters: { type: "object" } } }],
    timeoutMs: 1000,
    label: "test",
  });
  assert.equal(reply.content, "hello");
  assert.equal(reply.finishReason, "stop");
  assert.deepEqual(reply.toolCalls, []);
  assert.equal(reply.promptTokens, 12);
  assert.equal(reply.completionTokens, 34);
  assert.ok(reply.latencyMs >= 0);

  assert.ok(captured, "fetch was not called");
  assert.equal(captured.url, OPENROUTER_URL);
  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured.init.method, "POST");
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
  assert.match(headers["content-type"] ?? "", /application\/json/);
  assert.ok(headers["http-referer"], "app attribution header");
  assert.ok(headers["x-title"], "app title header");
  assert.equal(headers["x-api-key"], undefined, "no Anthropic-style header leaks into the OpenRouter request");

  const body = JSON.parse(String(captured.init.body)) as Record<string, unknown>;
  assert.equal(body.model, "anthropic/claude-haiku-4.5");
  assert.equal(body.max_tokens, 512);
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "health", description: "d", parameters: { type: "object" } } },
  ]);
  assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
});

test("no tools → no tools field at all", async () => {
  await chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1, timeoutMs: 1000, label: "t" });
  const body = JSON.parse(String(captured!.init.body)) as Record<string, unknown>;
  assert.equal("tools" in body, false);
});

// --- response contract ---------------------------------------------------------

test("tool_calls are returned with id, name, and the raw JSON-string arguments", async () => {
  nextResponse = () =>
    apiResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_proposal", arguments: '{"proposal_id":"abc"}' } },
              { id: "call_2", type: "function", function: { name: "health", arguments: "{}" } },
              { id: 42, type: "function", function: { name: "bogus" } }, // malformed → dropped
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
  const reply = await chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1, timeoutMs: 1000, label: "t" });
  assert.equal(reply.content, null);
  assert.equal(reply.finishReason, "tool_calls");
  assert.deepEqual(reply.toolCalls, [
    { id: "call_1", type: "function", function: { name: "get_proposal", arguments: '{"proposal_id":"abc"}' } },
    { id: "call_2", type: "function", function: { name: "health", arguments: "{}" } },
  ]);
});

test("HTTP error surfaces OpenRouter's message and status — never the key", async () => {
  nextResponse = () => apiResponse({ error: { code: 402, message: "Insufficient credits" } }, 402);
  await assert.rejects(
    chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1, timeoutMs: 1000, label: "t" }),
    (err: Error) => {
      assert.match(err.message, /HTTP 402: Insufficient credits/);
      assert.ok(!err.message.includes(TEST_KEY), "the API key must never appear in error messages");
      return true;
    },
  );
});

test("a 200 whose body is only { error } (provider failed after accepting) is an error, not an empty reply", async () => {
  nextResponse = () => apiResponse({ error: { code: 502, message: "Provider returned error" } }, 200);
  await assert.rejects(
    chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1, timeoutMs: 1000, label: "t" }),
    /Provider returned error/,
  );
});

test("finish_reason \"error\" inside a choice is an error too", async () => {
  nextResponse = () =>
    apiResponse({
      choices: [{ message: { content: "partial" }, finish_reason: "error" }],
      error: { code: 502, message: "upstream timeout" },
    });
  await assert.rejects(
    chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1, timeoutMs: 1000, label: "t" }),
    /upstream timeout/,
  );
});

test("network failure error never contains the key either", async () => {
  globalThis.fetch = (async () => {
    throw new Error("socket hang up");
  }) as typeof fetch;
  await assert.rejects(
    chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1, timeoutMs: 1000, label: "t" }),
    (err: Error) => {
      assert.match(err.message, /socket hang up/);
      assert.ok(!err.message.includes(TEST_KEY));
      return true;
    },
  );
});

test("missing key fails before any network call", async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(
    chatCompletion({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1, timeoutMs: 1000, label: "t" }),
    /OPENROUTER_API_KEY is not set/,
  );
  assert.equal(captured, null, "no request may be attempted without a key");
});
