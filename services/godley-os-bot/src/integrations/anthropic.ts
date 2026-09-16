// Anthropic Messages API over plain fetch — no SDK, same policy as every
// other HTTP integration in this service (openai.ts, blotato.ts). This is
// the AI Manager's model client: one call per conversation step, with
// tool-use so the manager can read OS state (and *propose* actions — the
// confirm-before-act gate lives in src/lib/manager.ts, never here and never
// in the prompt alone).
//
// Boundaries:
//  - The API key must never appear in logs or error messages: errors carry
//    the HTTP status and Anthropic's own error message only, never request
//    headers or the full payload.
//  - Latency and token usage are logged per call (cost visibility), never
//    the key and never message contents.
//  - Slow work — never await this before acking a Slack request.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// The manager's model — the single place to change it. claude-haiku-4-5 is
// the fast/cheap choice (~$1/$5 per MTok): snappy replies on a phone and
// pennies per conversation, at the cost of weaker multi-step reasoning than
// claude-sonnet-5 (~2x price) or claude-opus-5 (~5x). If the manager starts
// misreading multi-step asks ("approve both", cross-venture comparisons),
// upgrade here — nothing else changes.
export const MANAGER_MODEL = "claude-haiku-4-5";

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

export async function callClaude(args: CallClaudeArgs): Promise<ModelReply> {
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
