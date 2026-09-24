// The WhatsApp framing agent: one chat completion (GPT-4o mini) that
// rewrites an approved weekly market brief as a WhatsApp-ready message —
// through OpenRouter by default (one AI account for the whole bot, see
// openrouter.ts) or the OpenAI API directly behind AI_PROVIDER=direct.
// Plain fetch — no OpenAI SDK, same policy as every other HTTP integration
// in this service.
//
// Boundaries:
//  - The model REFRAMES, it never reports: the system prompt bars any market
//    number or fact not present in the source brief, and the human approves
//    the result before it goes anywhere (it is filed as a pending proposal).
//  - Nothing here sends to WhatsApp. The approved text is posted to Slack
//    for the owner to paste into their group by hand — that last hop is
//    always manual.
//  - Slow work (up to FRAMING_TIMEOUT_MS) — never await this before acking
//    a Slack request; it runs only in the background poll cycle.
//  - The API key must never appear in logs: errors carry the HTTP status
//    and OpenAI's error message only, never request headers.

import { chatCompletion, resolveAiProvider } from "./openrouter.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Cheap and more than sufficient for reframing; change here to upgrade —
// once per provider (the two names must stay the same model).
export const FRAMING_MODEL = "gpt-4o-mini";
export const FRAMING_MODEL_OPENROUTER = "openai/gpt-4o-mini";

const FRAMING_TIMEOUT_MS = 60_000;
// ~1200 chars requested of the model; tokens capped with headroom so a
// runaway completion can't get expensive.
const FRAMING_MAX_TOKENS = 800;

// ---------------------------------------------------------------------------
// TUNE ME: this is the framing agent's voice. Edit freely — nothing else in
// the pipeline depends on the wording, only on the data-invention ban, the
// rough length cap, and the verbatim disclaimer. The template below is the
// owner-approved target format.
// ---------------------------------------------------------------------------
export const FRAMING_SYSTEM_PROMPT = `You rewrite a weekly stock-market brief as a WhatsApp message for a small private group of friends interested in swing trading. Your output must follow this EXACT template structure (plain text, WhatsApp-ready):

🐂 LIL BULL — WEEKLY MARKET BRIEF
📅 Week of <date>
Market Outlook
<emoji> S&P 500: <stance>
<emoji> SNDK: <stance>
<emoji> INTEL: <stance>
⚖️ Weekly Lean: <LEAN> — <Conviction> Conviction
<2-3 sentence narrative synthesizing the week's setup>
Key Levels
- S&P 500: <level>
- SNDK: $<level>
- INTEL: $<level>
📆 What Matters This Week
- <day>: <events/earnings>
(3-5 bullets from the brief's calendar)
Bottom Line: <2-3 sentences: what confirms or invalidates each stance, and what drives the week>
Analysis only — not financial advice. Trade your own plan.

Rules:
- Stance emojis: 🟢 bullish, 🟡 neutral, 🔴 bearish. Use no emojis beyond the ones the template shows.
- Every number — date, price, level, percentage, indicator reading, calendar item — must come from the source brief. NEVER state a number or market fact that is not present in it. If the brief lacks a value the template asks for, write "n/a" instead of inventing one.
- Fill the date, stances, lean, conviction, levels, and calendar bullets from the source brief; the narrative and Bottom Line are your synthesis of the brief's content only. Keep any "data unavailable" warnings from the original.
- The template lists the current lineup; if the source brief covers different symbols, use the symbols the brief actually covers, one Market Outlook line and one Key Level per symbol, same format.
- Hard cap: about 1200 characters total.
- Plain text only: no markdown tables of any kind (WhatsApp cannot render them), no markdown headers, no links unless they are in the source.
- The final line is mandatory and must appear verbatim: "Analysis only — not financial advice. Trade your own plan."`;

export async function frameForWhatsApp(briefText: string): Promise<string> {
  return completeFraming({ system: FRAMING_SYSTEM_PROMPT, user: briefText, maxTokens: FRAMING_MAX_TOKENS, label: "framing" });
}

// The framing agent's second job (video phase): rewrite approved text as the
// spoken script of a short video. Same model, same provider paths, its own
// TUNE ME prompt (src/lib/video-script.ts). The user turn carries the source
// text plus the venture's call-to-action so the script can end on it.
export async function writeVideoScript(args: { system: string; sourceText: string; cta: string }): Promise<string> {
  const user = `SOURCE TEXT:\n${args.sourceText.trim()}\n\nCALL TO ACTION (say this, in these words, as the last line):\n${args.cta.trim()}`;
  return completeFraming({ system: args.system, user, maxTokens: VIDEO_SCRIPT_MAX_TOKENS, label: "video-script" });
}

// ~90 seconds of speech is ~230 words; capped with headroom.
const VIDEO_SCRIPT_MAX_TOKENS = 700;

interface FramingCall {
  system: string;
  user: string;
  maxTokens: number;
  label: string;
}

// One system message + one user message → trimmed text, on whichever
// provider path is configured. Shared by both framing jobs.
async function completeFraming(call: FramingCall): Promise<string> {
  return resolveAiProvider() === "direct" ? frameDirect(call) : frameViaOpenRouter(call);
}

// OpenRouter path (default): same two messages, the OpenRouter slug.
async function frameViaOpenRouter(call: FramingCall): Promise<string> {
  const reply = await chatCompletion({
    model: FRAMING_MODEL_OPENROUTER,
    messages: [
      { role: "system", content: call.system },
      { role: "user", content: call.user },
    ],
    maxTokens: call.maxTokens,
    timeoutMs: FRAMING_TIMEOUT_MS,
    label: call.label,
  });
  if (!reply.content || !reply.content.trim()) {
    throw new Error("OpenRouter returned an empty completion");
  }
  return reply.content.trim();
}

// Direct path (AI_PROVIDER=direct): the OpenAI chat-completions API as before.
async function frameDirect(call: FramingCall): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FRAMING_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: FRAMING_MODEL,
        max_tokens: call.maxTokens,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`OpenAI framing call timed out after ${FRAMING_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`OpenAI framing call failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Surface OpenAI's own error message (never our request headers).
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string") detail = `HTTP ${res.status}: ${body.error.message}`;
    } catch {
      // Non-JSON error body — the status alone will have to do.
    }
    throw new Error(`OpenAI framing call failed: ${detail}`);
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI returned an empty completion");
  }
  return content.trim();
}
