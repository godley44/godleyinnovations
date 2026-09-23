// Integration-shaped tests of the framing call's REQUEST CONSTRUCTION
// against a mocked fetch — CI never hits OpenRouter or the OpenAI API. Two
// suites: the OpenRouter path (the default) and the direct OpenAI path
// behind AI_PROVIDER=direct. Each test file runs in its own process under
// `node --test`, so swapping globalThis.fetch and the env here cannot leak
// into other suites.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { FRAMING_MODEL, FRAMING_MODEL_OPENROUTER, FRAMING_SYSTEM_PROMPT, frameForWhatsApp } from "./openai.js";

const realFetch = globalThis.fetch;
const OPENAI_TEST_KEY = "sk-test-key-not-real-123";
const OPENROUTER_TEST_KEY = "sk-or-v1-test-key-not-real-456";

let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
}

function resetEnv(): void {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

beforeEach(() => {
  resetEnv();
  captured = null;
  nextResponse = () => completion("  framed message  ");
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEnv();
});

test("both model constants are GPT-4o mini", () => {
  assert.equal(FRAMING_MODEL, "gpt-4o-mini");
  assert.equal(FRAMING_MODEL_OPENROUTER, "openai/gpt-4o-mini");
});

test("system prompt carries the non-negotiables: template, emojis, no invented data, cap, disclaimer", () => {
  assert.ok(FRAMING_SYSTEM_PROMPT.includes("🐂 LIL BULL — WEEKLY MARKET BRIEF"), "template header");
  assert.ok(FRAMING_SYSTEM_PROMPT.includes("🟢 bullish, 🟡 neutral, 🔴 bearish"), "stance emoji mapping");
  assert.ok(
    FRAMING_SYSTEM_PROMPT.includes("SNDK") && FRAMING_SYSTEM_PROMPT.includes("INTEL"),
    "current ticker lineup",
  );
  assert.match(FRAMING_SYSTEM_PROMPT, /NEVER state a number or market fact that is not present/);
  assert.match(FRAMING_SYSTEM_PROMPT, /1200 characters/);
  assert.match(FRAMING_SYSTEM_PROMPT, /no markdown tables/i);
  assert.ok(
    FRAMING_SYSTEM_PROMPT.includes('verbatim: "Analysis only — not financial advice. Trade your own plan."'),
    "mandatory verbatim disclaimer",
  );
});

describe("OpenRouter path (default)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = OPENROUTER_TEST_KEY;
  });

  test("request: OpenRouter endpoint, bearer auth, model slug, message roles", async () => {
    const result = await frameForWhatsApp("BRIEF TEXT");
    assert.equal(result, "framed message", "content is returned trimmed");

    assert.ok(captured, "fetch was not called");
    assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured.init.method, "POST");
    const headers = captured.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${OPENROUTER_TEST_KEY}`);
    assert.match(headers["content-type"] ?? "", /application\/json/);

    const body = JSON.parse(String(captured.init.body)) as {
      model: string;
      max_tokens: number;
      messages: { role: string; content: string }[];
      tools?: unknown;
    };
    assert.equal(body.model, FRAMING_MODEL_OPENROUTER);
    assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0, "a token cap must be set");
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages[0], { role: "system", content: FRAMING_SYSTEM_PROMPT });
    assert.deepEqual(body.messages[1], { role: "user", content: "BRIEF TEXT" });
    assert.equal(body.tools, undefined, "framing uses no tools");
    assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
  });

  test("API error surfaces OpenRouter's message and status — never a key", async () => {
    process.env.OPENAI_API_KEY = OPENAI_TEST_KEY;
    nextResponse = () =>
      new Response(JSON.stringify({ error: { code: 429, message: "Rate limit reached" } }), { status: 429 });
    await assert.rejects(frameForWhatsApp("brief"), (err: Error) => {
      assert.match(err.message, /HTTP 429: Rate limit reached/);
      assert.ok(!err.message.includes(OPENROUTER_TEST_KEY), "the OpenRouter key must never appear in error messages");
      assert.ok(!err.message.includes(OPENAI_TEST_KEY), "the OpenAI key must never appear in error messages");
      return true;
    });
  });

  test("empty completion is an error, not an empty proposal", async () => {
    nextResponse = () => completion("");
    await assert.rejects(frameForWhatsApp("brief"), /empty completion/);
  });

  test("AI_PROVIDER=openrouter without a key fails before any network call", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_PROVIDER = "openrouter";
    await assert.rejects(frameForWhatsApp("brief"), /OPENROUTER_API_KEY is not set/);
    assert.equal(captured, null, "no request may be attempted without a key");
  });
});

describe("direct OpenAI path (AI_PROVIDER=direct)", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = "direct";
    process.env.OPENAI_API_KEY = OPENAI_TEST_KEY;
    // An OpenRouter key being present must not override the explicit flag.
    process.env.OPENROUTER_API_KEY = OPENROUTER_TEST_KEY;
  });

  test("request: endpoint, method, auth header shape, model, message roles", async () => {
    const result = await frameForWhatsApp("BRIEF TEXT");
    assert.equal(result, "framed message", "content is returned trimmed");

    assert.ok(captured, "fetch was not called");
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(captured.init.method, "POST");

    const headers = captured.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${OPENAI_TEST_KEY}`);
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

  test("API error surfaces OpenAI's message and status — never the key", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 });
    await assert.rejects(frameForWhatsApp("brief"), (err: Error) => {
      assert.match(err.message, /HTTP 429: Rate limit reached/);
      assert.ok(!err.message.includes(OPENAI_TEST_KEY), "the API key must never appear in error messages");
      return true;
    });
  });

  test("empty completion is an error, not an empty proposal", async () => {
    nextResponse = () => completion("");
    await assert.rejects(frameForWhatsApp("brief"), /empty completion/);
  });

  test("missing key fails before any network call", async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(frameForWhatsApp("brief"), /OPENAI_API_KEY is not set/);
    assert.equal(captured, null, "no request may be attempted without a key");
  });
});

test("no OpenRouter key and no flag → the direct path is used (transition default)", async () => {
  process.env.OPENAI_API_KEY = OPENAI_TEST_KEY;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await frameForWhatsApp("brief");
  } finally {
    console.warn = realWarn;
  }
  assert.equal(captured!.url, "https://api.openai.com/v1/chat/completions");
});
