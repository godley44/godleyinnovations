// Integration-shaped test of the Messages API call's REQUEST CONSTRUCTION
// against a mocked fetch — CI never hits the Anthropic API. Each test file
// runs in its own process under `node --test`, so swapping globalThis.fetch
// and the env here cannot leak into other suites.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { MANAGER_TOOLS } from "../lib/manager-tools.js";
import { callClaude, MANAGER_MODEL } from "./anthropic.js";

const realFetch = globalThis.fetch;
const TEST_KEY = "sk-ant-test-key-not-real-123";

let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = TEST_KEY;
  captured = null;
  nextResponse = () =>
    apiResponse({
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 34 },
    });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
});

test("request: endpoint, method, headers, model constant, tool definitions present", async () => {
  const reply = await callClaude({
    system: "SYSTEM PROMPT",
    messages: [{ role: "user", content: "what's pending?" }],
    tools: MANAGER_TOOLS,
  });
  assert.equal(reply.content[0]?.type, "text");
  assert.equal(reply.stopReason, "end_turn");
  assert.equal(reply.inputTokens, 12);
  assert.equal(reply.outputTokens, 34);
  assert.ok(reply.latencyMs >= 0, "latency is measured per call");

  assert.ok(captured, "fetch was not called");
  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.init.method, "POST");

  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], TEST_KEY);
  assert.ok(headers["anthropic-version"], "an anthropic-version header must be set");
  assert.match(headers["content-type"] ?? "", /application\/json/);

  const body = JSON.parse(String(captured.init.body)) as {
    model: string;
    max_tokens: number;
    system: string;
    messages: unknown[];
    tools: { name: string; description: string; input_schema: unknown }[];
  };
  assert.equal(body.model, MANAGER_MODEL, "the model comes from the single constant");
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0, "a token cap must be set");
  assert.equal(body.system, "SYSTEM PROMPT");
  assert.equal(body.messages.length, 1);

  // The manager's tool surface rides in every request: all READ and ACT
  // definitions, each with a JSON schema.
  const toolNames = body.tools.map((t) => t.name);
  for (const name of [
    "list_pending_proposals",
    "get_proposal",
    "recent_activity",
    "venture_overview",
    "health",
    "approve_proposal",
    "reject_proposal",
    "create_social_draft",
  ]) {
    assert.ok(toolNames.includes(name), `tool definition missing: ${name}`);
  }
  for (const tool of body.tools) {
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.ok(tool.input_schema, `${tool.name} needs an input_schema`);
  }
  assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
});

test("tool_use blocks are parsed with id, name, and input", async () => {
  nextResponse = () =>
    apiResponse({
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu_abc", name: "list_pending_proposals", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  const reply = await callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(reply.stopReason, "tool_use");
  const toolUse = reply.content.find((b) => b.type === "tool_use");
  assert.ok(toolUse && toolUse.type === "tool_use");
  assert.equal(toolUse.id, "tu_abc");
  assert.equal(toolUse.name, "list_pending_proposals");
  assert.deepEqual(toolUse.input, {});
});

test("API error surfaces Anthropic's message and status — never the key", async () => {
  nextResponse = () => apiResponse({ error: { type: "rate_limit_error", message: "Rate limited" } }, 429);
  await assert.rejects(
    callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }),
    (err: Error) => {
      assert.match(err.message, /HTTP 429: Rate limited/);
      assert.ok(!err.message.includes(TEST_KEY), "the API key must never appear in error messages");
      return true;
    },
  );
});

test("network failure error never contains the key either", async () => {
  globalThis.fetch = (async () => {
    throw new Error("socket hang up");
  }) as typeof fetch;
  await assert.rejects(
    callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }),
    (err: Error) => {
      assert.match(err.message, /socket hang up/);
      assert.ok(!err.message.includes(TEST_KEY), "the API key must never appear in error messages");
      return true;
    },
  );
});

test("missing key fails before any network call", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }), /ANTHROPIC_API_KEY is not set/);
  assert.equal(captured, null, "no request may be attempted without a key");
});
