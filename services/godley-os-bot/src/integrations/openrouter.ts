// OpenRouter — the ONE AI account the bot bills to. Both model clients
// (anthropic.ts for the AI Manager, openai.ts for the WhatsApp framing agent)
// call this module by default: one key (OPENROUTER_API_KEY), one endpoint,
// OpenAI-compatible chat completions, the model chosen per call by its
// OpenRouter slug (kept as constants in the two callers). Plain fetch — no
// SDK, same policy as every other HTTP integration in this service.
//
// The direct-provider code paths (api.anthropic.com / api.openai.com with
// their own keys) still exist in the callers, behind resolveAiProvider():
//   AI_PROVIDER=direct      → always direct providers
//   AI_PROVIDER=openrouter  → always OpenRouter (missing key = loud error)
//   unset                   → OpenRouter when OPENROUTER_API_KEY is set,
//                             else direct (logged as a warning per call, so
//                             the day the key lands nothing else changes)
// Keep the direct paths: OpenRouter's OpenAI-shaped API cannot carry
// Anthropic-native request features — server-side tools (web_search), beta
// headers (server-side fallbacks, structured outputs / output_config), or
// the Anthropic `system` + `input_schema` wire format — so anything that
// needs those (today: the two Deno edge functions, which use the Anthropic
// SDK directly) stays on ANTHROPIC_API_KEY and never comes through here.
//
// Boundaries (identical to the direct clients):
//  - The key never appears in logs or error messages: errors carry the HTTP
//    status and OpenRouter's own error message only, never request headers.
//  - Latency and token usage are logged per call; message contents never.
//  - Slow work — never await this before acking a Slack request.
//  - A 200 whose body is only { error } (OpenRouter's "provider failed
//    after accepting" case) is an error here, never an empty reply.

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Sent as app attribution headers (OpenRouter's optional HTTP-Referer /
// X-Title); nothing secret, nothing per-user.
const APP_URL = "https://github.com/godley44/godleyinnovations";
const APP_TITLE = "godley-os-bot";

export type AiProvider = "openrouter" | "direct";

export function resolveAiProvider(): AiProvider {
  const flag = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (flag === "direct") return "direct";
  if (flag === "openrouter") return "openrouter";
  if (flag) throw new Error(`AI_PROVIDER must be "openrouter" or "direct" (got "${flag}")`);
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  console.warn("[ai] OPENROUTER_API_KEY is not set — using the direct providers (ANTHROPIC_API_KEY / OPENAI_API_KEY)");
  return "direct";
}

export interface OpenRouterTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenRouterMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenRouterToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatCompletionArgs {
  model: string;
  messages: OpenRouterMessage[];
  maxTokens: number;
  tools?: OpenRouterTool[];
  timeoutMs: number;
  // Log prefix for the per-call cost line, e.g. "manager" / "framing".
  label: string;
}

export interface ChatCompletionReply {
  content: string | null;
  toolCalls: OpenRouterToolCall[];
  // OpenRouter's normalized finish_reason: "stop" | "length" | "tool_calls" |
  // "content_filter" | "error" (null when absent).
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

// Tool calls arrive untyped; normalize defensively instead of casting blind.
function normalizeToolCall(raw: unknown): OpenRouterToolCall | null {
  if (typeof raw !== "object" || raw === null) return null;
  const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
  if (typeof call.id !== "string" || typeof call.function?.name !== "string") return null;
  const args = call.function.arguments;
  return {
    id: call.id,
    type: "function",
    function: { name: call.function.name, arguments: typeof args === "string" ? args : "{}" },
  };
}

function errorMessageOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const err = (body as { error?: { message?: unknown } }).error;
  return typeof err?.message === "string" ? err.message : null;
}

export async function chatCompletion(args: ChatCompletionArgs): Promise<ChatCompletionReply> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "http-referer": APP_URL,
        "x-title": APP_TITLE,
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens,
        messages: args.messages,
        ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`OpenRouter call timed out after ${args.timeoutMs / 1000}s`);
    }
    throw new Error(`OpenRouter call failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Surface OpenRouter's own error message (never our request headers).
    let detail = `HTTP ${res.status}`;
    try {
      const message = errorMessageOf(await res.json());
      if (message) detail = `HTTP ${res.status}: ${message}`;
    } catch {
      // Non-JSON error body — the status alone will have to do.
    }
    throw new Error(`OpenRouter call failed: ${detail}`);
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown[] }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    error?: unknown;
  };
  const choice = body.choices?.[0];
  if (!choice) {
    // OpenRouter answers 200 with { error } alone when the provider fails
    // after accepting the request.
    throw new Error(`OpenRouter call failed: ${errorMessageOf(body) ?? "no choices in the response"}`);
  }
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  if (finishReason === "error") {
    throw new Error(`OpenRouter call failed: ${errorMessageOf(body) ?? "the provider reported an error mid-response"}`);
  }
  const content = typeof choice.message?.content === "string" ? choice.message.content : null;
  const toolCalls = (choice.message?.tool_calls ?? [])
    .map(normalizeToolCall)
    .filter((c): c is OpenRouterToolCall => c !== null);
  const latencyMs = Date.now() - startedAt;
  const promptTokens = typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : 0;
  const completionTokens = typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : 0;

  // Cost visibility per call — latency and tokens only, never the key and
  // never message contents.
  console.log(
    `[openrouter] ${args.label} ${args.model} latency=${latencyMs}ms tokens_in=${promptTokens} ` +
      `tokens_out=${completionTokens} finish=${finishReason ?? "?"} tool_calls=${toolCalls.length}`,
  );

  return { content, toolCalls, finishReason, promptTokens, completionTokens, latencyMs };
}
