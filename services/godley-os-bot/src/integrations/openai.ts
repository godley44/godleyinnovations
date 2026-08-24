// The WhatsApp framing agent: one call to the OpenAI chat-completions API
// that rewrites an approved weekly market brief as a WhatsApp-ready message.
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

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Cheap and more than sufficient for reframing; change here to upgrade.
export const FRAMING_MODEL = "gpt-4o-mini";

const FRAMING_TIMEOUT_MS = 60_000;
// ~1200 chars requested of the model; tokens capped with headroom so a
// runaway completion can't get expensive.
const FRAMING_MAX_TOKENS = 800;

// ---------------------------------------------------------------------------
// TUNE ME: this is the framing agent's voice. Edit freely — nothing else in
// the pipeline depends on the wording, only on the data-invention ban and
// the rough length cap.
// ---------------------------------------------------------------------------
export const FRAMING_SYSTEM_PROMPT = `You rewrite a weekly stock-market brief as a WhatsApp message for a small private group of friends interested in swing trading.

Rules:
- Conversational but credible — a sharp friend sharing their read, not a newsletter.
- Lead with the single headline takeaway for the coming week.
- Compress the timeframe detail: mention only the readings that matter for this week's trading, in plain words. No tables of any kind — WhatsApp cannot render them.
- Keep any risk caveats or "data unavailable" warnings from the original. Keep the "not financial advice" spirit in one short line.
- NEVER state a price, level, percentage, indicator reading, or calendar event that is not present in the source brief. You reframe; you never add market data.
- End with exactly one engaging question to the group.
- Hard cap: about 1200 characters total.
- Emoji: sparing — 2 to 4 in the whole message.
- Plain text only: no markdown headers, no bullet syntax that WhatsApp won't render (a simple "-" list is fine), no links unless they are in the source.`;

export async function frameForWhatsApp(briefText: string): Promise<string> {
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
        max_tokens: FRAMING_MAX_TOKENS,
        messages: [
          { role: "system", content: FRAMING_SYSTEM_PROMPT },
          { role: "user", content: briefText },
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
