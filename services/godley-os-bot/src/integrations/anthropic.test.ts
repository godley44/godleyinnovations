// Integration-shaped tests of the manager model client's REQUEST
// CONSTRUCTION and response mapping against a mocked fetch — CI never hits
// OpenRouter or the Anthropic API. Two suites: the OpenRouter path (the
// default) including the full tool-use round-trip the manager relies on,
// and the direct Anthropic path behind AI_PROVIDER=direct. Each test file
// runs in its own process under `node --test`, so swapping globalThis.fetch
// and the env here cannot leak into other suites.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { MANAGER_TOOLS } from "../lib/manager-tools.js";
import {
  callClaude,
  MANAGER_MODEL,
  MANAGER_MODEL_OPENROUTER,
  toOpenRouterMessages,
  toOpenRouterTools,
  toStopReason,
  type ChatMessage,
} from "./anthropic.js";

const realFetch = globalThis.fetch;
const ANTHROPIC_TEST_KEY = "sk-ant-test-key-not-real-123";
const OPENROUTER_TEST_KEY = "sk-or-v1-test-key-not-real-456";

let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function resetEnv(): void {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
}

beforeEach(() => {
  resetEnv();
  captured = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetEnv();
});

// The model constants name the same model on both providers.
test("both model constants are Claude Haiku", () => {
  assert.equal(MANAGER_MODEL, "claude-haiku-4-5");
  assert.equal(MANAGER_MODEL_OPENROUTER, "anthropic/claude-haiku-4.5");
});

describe("OpenRouter path (default)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = OPENROUTER_TEST_KEY;
    nextResponse = () =>
      apiResponse({
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      });
  });

  test("request: OpenRouter endpoint, bearer auth, model slug, system message first, tool definitions mapped", async () => {
    const reply = await callClaude({
      system: "SYSTEM PROMPT",
      messages: [{ role: "user", content: "what's pending?" }],
      tools: MANAGER_TOOLS,
    });
    assert.deepEqual(reply.content, [{ type: "text", text: "hello" }]);
    assert.equal(reply.stopReason, "end_turn", "finish_reason stop maps to Anthropic's end_turn");
    assert.equal(reply.inputTokens, 12);
    assert.equal(reply.outputTokens, 34);
    assert.ok(reply.latencyMs >= 0, "latency is measured per call");

    assert.ok(captured, "fetch was not called");
    assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured.init.method, "POST");
    const headers = captured.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${OPENROUTER_TEST_KEY}`);
    assert.equal(headers["x-api-key"], undefined, "the Anthropic key header never goes to OpenRouter");

    const body = JSON.parse(String(captured.init.body)) as {
      model: string;
      max_tokens: number;
      messages: { role: string; content: string }[];
      tools: { type: string; function: { name: string; description: string; parameters: unknown } }[];
    };
    assert.equal(body.model, MANAGER_MODEL_OPENROUTER, "the model comes from the single OpenRouter constant");
    assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0, "a token cap must be set");
    assert.deepEqual(body.messages[0], { role: "system", content: "SYSTEM PROMPT" });
    assert.deepEqual(body.messages[1], { role: "user", content: "what's pending?" });
    assert.equal(body.messages.length, 2);

    // The manager's whole tool surface rides in every request, in
    // OpenRouter's function shape, each with its JSON schema.
    const toolNames = body.tools.map((t) => t.function.name);
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
      assert.equal(tool.type, "function");
      assert.ok(tool.function.description.length > 0, `${tool.function.name} needs a description`);
      assert.ok(tool.function.parameters, `${tool.function.name} needs a parameters schema`);
    }
    const health = body.tools.find((t) => t.function.name === "health")!;
    assert.deepEqual(
      health.function.parameters,
      MANAGER_TOOLS.find((t) => t.name === "health")!.input_schema,
      "parameters is the tool's input_schema verbatim",
    );
    assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
  });

  test("tool_calls map to tool_use blocks with parsed input, and stop reason tool_use", async () => {
    nextResponse = () =>
      apiResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: "let me check",
              tool_calls: [
                {
                  id: "toolu_abc",
                  type: "function",
                  function: { name: "get_proposal", arguments: '{"proposal_id":"11111111-1111-4111-8111-111111111111"}' },
                },
                { id: "toolu_def", type: "function", function: { name: "list_pending_proposals", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      });
    const reply = await callClaude({ system: "s", messages: [{ role: "user", content: "hi" }], tools: MANAGER_TOOLS });
    assert.equal(reply.stopReason, "tool_use");
    assert.deepEqual(reply.content, [
      { type: "text", text: "let me check" },
      {
        type: "tool_use",
        id: "toolu_abc",
        name: "get_proposal",
        input: { proposal_id: "11111111-1111-4111-8111-111111111111" },
      },
      { type: "tool_use", id: "toolu_def", name: "list_pending_proposals", input: {} },
    ]);
  });

  test("the manager's tool round-trip: assistant tool_use + user tool_result become tool_calls + tool messages", async () => {
    // Exactly the message history manager.ts builds after one READ tool
    // round: the model's turn (text + tool_use blocks) echoed back as the
    // assistant message, then the results as a user turn of tool_result
    // blocks. OpenRouter wants the former as tool_calls (arguments as a
    // JSON string) and the latter as one `tool` message per call id.
    const messages: ChatMessage[] = [
      { role: "user", content: "<@U1>: what's pending?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "list_pending_proposals", input: {} },
          { type: "tool_use", id: "toolu_2", name: "get_proposal", input: { proposal_id: "abc" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: '[{"id":"abc"}]' },
          { type: "tool_result", tool_use_id: "toolu_2", content: "Error: not found", is_error: true },
        ],
      },
    ];
    await callClaude({ system: "SYS", messages, tools: MANAGER_TOOLS });
    const body = JSON.parse(String(captured!.init.body)) as { messages: unknown[] };
    assert.deepEqual(body.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "<@U1>: what's pending?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "list_pending_proposals", arguments: "{}" } },
          { id: "toolu_2", type: "function", function: { name: "get_proposal", arguments: '{"proposal_id":"abc"}' } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: '[{"id":"abc"}]' },
      { role: "tool", tool_call_id: "toolu_2", content: "Error: not found" },
    ]);
  });

  test("an assistant turn of tool_use only has content null (no empty string)", () => {
    const out = toOpenRouterMessages("S", [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "health", input: {} }] },
    ]);
    assert.deepEqual(out[1], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t", type: "function", function: { name: "health", arguments: "{}" } }],
    });
  });

  test("toOpenRouterTools keeps name, description and input_schema", () => {
    assert.deepEqual(toOpenRouterTools([{ name: "n", description: "d", input_schema: { type: "object" } }]), [
      { type: "function", function: { name: "n", description: "d", parameters: { type: "object" } } },
    ]);
  });

  test("stop reasons: tool_calls/any tool call → tool_use, stop → end_turn, length → max_tokens, content_filter → refusal", () => {
    assert.equal(toStopReason("tool_calls", 1), "tool_use");
    assert.equal(toStopReason("stop", 1), "tool_use", "a tool call with a plain stop still means run the tools");
    assert.equal(toStopReason("stop", 0), "end_turn");
    assert.equal(toStopReason("length", 0), "max_tokens");
    assert.equal(toStopReason("content_filter", 0), "refusal");
    assert.equal(toStopReason(null, 0), null);
  });

  test("malformed JSON tool arguments are a loud error, never a silent empty input", async () => {
    nextResponse = () =>
      apiResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "t", type: "function", function: { name: "get_proposal", arguments: "{not json" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    await assert.rejects(
      callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }),
      /malformed JSON arguments for tool get_proposal/,
    );
  });

  test("API error surfaces OpenRouter's message and status — never a key", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_TEST_KEY;
    nextResponse = () => apiResponse({ error: { code: 429, message: "Rate limited" } }, 429);
    await assert.rejects(
      callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }),
      (err: Error) => {
        assert.match(err.message, /HTTP 429: Rate limited/);
        assert.ok(!err.message.includes(OPENROUTER_TEST_KEY), "the OpenRouter key must never appear in error messages");
        assert.ok(!err.message.includes(ANTHROPIC_TEST_KEY), "the Anthropic key must never appear in error messages");
        return true;
      },
    );
  });

  test("AI_PROVIDER=openrouter without a key fails before any network call", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_PROVIDER = "openrouter";
    await assert.rejects(callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }), /OPENROUTER_API_KEY is not set/);
    assert.equal(captured, null, "no request may be attempted without a key");
  });
});

describe("direct Anthropic path (AI_PROVIDER=direct)", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = "direct";
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_TEST_KEY;
    // An OpenRouter key being present must not override the explicit flag.
    process.env.OPENROUTER_API_KEY = OPENROUTER_TEST_KEY;
    nextResponse = () =>
      apiResponse({
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 34 },
      });
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
    assert.equal(headers["x-api-key"], ANTHROPIC_TEST_KEY);
    assert.ok(headers["anthropic-version"], "an anthropic-version header must be set");
    assert.equal(headers.authorization, undefined, "the OpenRouter bearer never goes to Anthropic");
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
        assert.ok(!err.message.includes(ANTHROPIC_TEST_KEY), "the API key must never appear in error messages");
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
        assert.ok(!err.message.includes(ANTHROPIC_TEST_KEY), "the API key must never appear in error messages");
        return true;
      },
    );
  });

  test("missing key fails before any network call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] }), /ANTHROPIC_API_KEY is not set/);
    assert.equal(captured, null, "no request may be attempted without a key");
  });
});

test("no OpenRouter key and no flag → the direct path is used (transition default)", async () => {
  process.env.ANTHROPIC_API_KEY = ANTHROPIC_TEST_KEY;
  nextResponse = () => apiResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await callClaude({ system: "s", messages: [{ role: "user", content: "hi" }] });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(captured!.url, "https://api.anthropic.com/v1/messages");
});
