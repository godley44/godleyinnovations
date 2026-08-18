// Content-framing stub: one call to the OpenAI chat-completions API with a
// placeholder system prompt. Like the research stub, this only proves the
// wiring; the framing pipeline itself comes later.
//
// Slow work — never await this before acking a Slack request.

import OpenAI from "openai";

// PLACEHOLDER — replace with the real framing system prompt when the
// pipeline is built.
const FRAMING_SYSTEM_PROMPT = "You frame reports into content. (Placeholder system prompt.)";

const FRAMING_MODEL = "gpt-4o";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  client = new OpenAI({ apiKey });
  return client;
}

export async function frameContent(report: string): Promise<string> {
  const completion = await getClient().chat.completions.create({
    model: FRAMING_MODEL,
    messages: [
      { role: "system", content: FRAMING_SYSTEM_PROMPT },
      { role: "user", content: report },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty completion");
  return content;
}
