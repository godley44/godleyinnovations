// The AI Manager's model client — Claude Haiku, reached through OpenRouter
// by default (one AI account for the whole bot, see openrouter.ts) or
// through the Anthropic Messages API directly behind AI_PROVIDER=direct.
// Plain fetch — no SDK, same policy as every other HTTP integration in this
// service (openai.ts, blotato.ts). One call per conversation step, with
// tool-use so the manager can read OS state (and *propose* actions — the
// confirm-before-act gate lives in src/lib/manager.ts, never here and never
// in the prompt alone).
//
// The rest of the bot speaks the Anthropic content-block shape (text /
// tool_use / tool_result) whichever provider answers: the OpenRouter path
// translates to and from OpenAI-style messages + tool_calls right here, so
// manager.ts is provider-agnostic. Tool calling is a documented OpenRouter
// feature for anthropic/claude-haiku-4.5 (its supported parameters include
// `tools` / `tool_choice`); the round-trip is pinned by anthropic.test.ts.
//
// Boundaries:
//  - The API key must never appear in logs or error messages: errors carry
//    the HTTP status and the provider's own error message only, never
//    request headers or the full payload.
//  - Latency and token usage are logged per call (cost visibility), never
//    the key and never message contents.
//  - Slow work — never await this before acking a Slack request.

import {
  chatCompletion,
  resolveAiProvider,
  type OpenRouterMessage,
  type OpenRouterTool,
  type OpenRouterToolCall,
} from "./openrouter.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// The manager's model — the single place to change it, once per provider
// (the two names must stay the same model). claude-haiku-4-5 is the
// fast/cheap choice (~$1/$5 per MTok, same price through OpenRouter, which
// adds no markup): snappy replies on a phone and pennies per conversation,
// at the cost of weaker multi-step reasoning than claude-sonnet-5 (~2x
// price) or claude-opus-5 (~5x). If the manager starts misreading
// multi-step asks ("approve both", cross-venture comparisons), upgrade
// here — nothing else changes.
export const MANAGER_MODEL = "claude-haiku-4-5";
export const MANAGER_MODEL_OPENROUTER = "anthropic/claude-haiku-4.5";

const CALL_TIMEOUT_MS = 60_000;
// Slack-sized replies; a runaway completion can't get expensive.
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | (ContentBlock | ToolResultBlock)[];
}

export interface ModelReply {
  content: ContentBlock[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface CallClaudeArgs {
  system: string;
  messages: ChatMessage[];
  tools?: AnthropicTool[];
  maxTokens?: number;
}

export async function callClaude(args: CallClaudeArgs): Promise<ModelReply> {
  return resolveAiProvider() === "direct" ? callClaudeDirect(args) : callClaudeViaOpenRouter(args);
}

// ---------------------------------------------------------------------------
// OpenRouter path (default): Anthropic blocks ⇄ OpenAI-style messages.
// ---------------------------------------------------------------------------

export function toOpenRouterTools(tools: AnthropicTool[]): OpenRouterTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

export function toOpenRouterMessages(system: string, messages: ChatMessage[]): OpenRouterMessage[] {
  const out: OpenRouterMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      // One assistant turn: its text (if any) plus every tool_use as a
      // tool_call, in the shape OpenRouter expects echoed back.
      const text = m.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls: OpenRouterToolCall[] = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // User turn made of blocks: each tool_result is its own `tool` message
    // (keyed by the call id); any text blocks become a user message.
    const text: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
      } else if (b.type === "text") {
        text.push(b.text);
      }
    }
    if (text.length > 0) out.push({ role: "user", content: text.join("\n") });
  }
  return out;
}

function parseToolInput(call: OpenRouterToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch {
    throw new Error(`OpenRouter returned malformed JSON arguments for tool ${call.function.name}`);
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

// OpenRouter's normalized finish_reason → Anthropic's stop_reason, which is
// what manager.ts branches on ("tool_use" = run the tools and loop).
export function toStopReason(finishReason: string | null, toolCallCount: number): string | null {
  if (toolCallCount > 0 || finishReason === "tool_calls") return "tool_use";
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return finishReason;
  }
}

async function callClaudeViaOpenRouter(args: CallClaudeArgs): Promise<ModelReply> {
  const reply = await chatCompletion({
    model: MANAGER_MODEL_OPENROUTER,
    messages: toOpenRouterMessages(args.system, args.messages),
    maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(args.tools && args.tools.length > 0 ? { tools: toOpenRouterTools(args.tools) } : {}),
    timeoutMs: CALL_TIMEOUT_MS,
    label: "manager",
  });
  const content: ContentBlock[] = [];
  if (reply.content && reply.content.trim()) content.push({ type: "text", text: reply.content });
  for (const call of reply.toolCalls) {
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolInput(call) });
  }
  return {
    content,
    stopReason: toStopReason(reply.finishReason, reply.toolCalls.length),
    inputTokens: reply.promptTokens,
    outputTokens: reply.completionTokens,
    latencyMs: reply.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Direct path (AI_PROVIDER=direct): the Anthropic Messages API as before.
// ---------------------------------------------------------------------------

// Response blocks arrive untyped; normalize defensively instead of casting
// blind (same discipline as the Supabase row handling).
function normalizeBlock(raw: unknown): ContentBlock | null {
  if (typeof raw !== "object" || raw === null) return null;
  const block = raw as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string"
  ) {
    const input =
      typeof block.input === "object" && block.input !== null
        ? (block.input as Record<string, unknown>)
        : {};
    return { type: "tool_use", id: block.id, name: block.name, input };
  }
  return null;
}

async function callClaudeDirect(args: CallClaudeArgs): Promise<ModelReply> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MANAGER_MODEL,
        max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: args.system,
        messages: args.messages,
        ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Anthropic call timed out after ${CALL_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Anthropic call failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Surface Anthropic's own error message (never our request headers).
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string") detail = `HTTP ${res.status}: ${body.error.message}`;
    } catch {
      // Non-JSON error body — the status alone will have to do.
    }
    throw new Error(`Anthropic call failed: ${detail}`);
  }

  const body = (await res.json()) as {
    content?: unknown[];
    stop_reason?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const content = (body.content ?? [])
    .map(normalizeBlock)
    .filter((b): b is ContentBlock => b !== null);
  const latencyMs = Date.now() - startedAt;
  const inputTokens = typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : 0;
  const outputTokens = typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : 0;
  const stopReason = typeof body.stop_reason === "string" ? body.stop_reason : null;

  // Cost visibility per call — latency and tokens only, never the key and
  // never message contents.
  console.log(
    `[anthropic] ${MANAGER_MODEL} latency=${latencyMs}ms tokens_in=${inputTokens} ` +
      `tokens_out=${outputTokens} stop=${stopReason ?? "?"}`,
  );

  return { content, stopReason, inputTokens, outputTokens, latencyMs };
}
