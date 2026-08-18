// Research stub: one call to the Anthropic API (claude-opus-5) with a
// placeholder system prompt. The research PIPELINE (what triggers this, where
// the result goes) is deliberately not built yet — this file only proves the
// API wiring, so the pipeline work later is prompt + plumbing, not auth
// debugging.
//
// Callers must treat this as slow (minutes, not milliseconds): never await it
// before acking a Slack request — fire it after the immediate 200.

import Anthropic from "@anthropic-ai/sdk";

// PLACEHOLDER — replace with the real research system prompt when the
// pipeline is built.
const RESEARCH_SYSTEM_PROMPT = "You are a research assistant. (Placeholder system prompt.)";

const RESEARCH_MODEL = "claude-opus-5";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  client = new Anthropic({ apiKey });
  return client;
}

export async function runResearch(topic: string): Promise<string> {
  const response = await getClient().beta.messages.create({
    model: RESEARCH_MODEL,
    max_tokens: 16000,
    // Server-side refusal fallback: if claude-opus-5 declines a request for
    // safety-classifier reasons, the API re-runs it on claude-opus-4-8 inside
    // the same call instead of returning nothing.
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    system: RESEARCH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: topic }],
  });

  let text = "";
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
  }
  if (!text) {
    throw new Error(
      `Anthropic returned no text (stop_reason: ${response.stop_reason ?? "unknown"})`,
    );
  }
  return text;
}
