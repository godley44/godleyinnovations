// claude-bridge: the claude persona's brain. The AI Mesh Bot router POSTs
// { instruction, context, channel, threadTs } here (see the bridge contract
// in services/ai-mesh-bot/README.md); this function calls the Claude API and
// returns { reply, osUpdate }.
//
// Two boundaries to keep straight:
//  - AUTH IN:  callers must present BRIDGE_SHARED_SECRET (same env var on the
//    router). The gate runs before anything else — a public URL that spends
//    model tokens needs a lock even though it holds no data.
//  - NO WRITES OUT: this function never touches the database or os-ingest.
//    It only *proposes* an osUpdate; the router decides whether to file it
//    (claude persona only) and which venture it lands on (channel mapping).
//    The model is told not to pick ventures — venture_slug is not in the
//    output schema, and the router overrides it anyway.
//
// Secrets (supabase function secrets): BRIDGE_SHARED_SECRET, ANTHROPIC_API_KEY.
//
// Model: claude-opus-5 with effort "low" — the router aborts bridge calls at
// 25s, so short thinking matters more than maximum depth here. Structured
// output guarantees the reply parses; server-side refusal fallbacks re-run a
// safety-declined request on the recommended fallback model automatically.

import Anthropic from "npm:@anthropic-ai/sdk";

type Json = Record<string, unknown>;

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SYSTEM_PROMPT = `You are the "claude" persona of the AI Mesh Bot at Godley Innovations, a one-operator venture studio. You reply inside Slack threads.

Keep replies short and Slack-friendly: plain conversational text, no markdown headers, no bullet walls. Lead with the answer.

You can also file OS updates. The Godley Innovations OS tracks each venture's money ledger, support tickets, and notes. An OS update you file becomes a PENDING PROPOSAL the owner approves or rejects on their phone — you draft, the human signs. File one only when the instruction asks to record something concrete (log a sale or expense, open a support ticket, append a note). Questions, discussion, and analysis get osUpdate: null.

Actions and their data:
- "ledger.add": { amount_cents (integer, positive = money in, negative = money out), category? (sale|advertising|operations|equipment|fees|funding|other), occurred_on? (YYYY-MM-DD), counterparty?, item?, note? }
- "ticket.add": { subject (required), customer?, channel?, opened_on? (YYYY-MM-DD) }
- "note.append": { text (required) }

The venture is decided by which Slack channel the message came from — never by you, so nothing in your output names a venture. When you file an osUpdate, say so briefly in the reply (e.g. "Filed a $500 sale for approval."). Amounts are always integer cents: $500 is 50000.

OUTPUT FORMAT — your entire response must be exactly one JSON object, no markdown fences, no text before or after it:
{"reply": "<the Slack reply>", "osUpdate": null}
or, when filing an update:
{"reply": "<the Slack reply>", "osUpdate": {"action": "ledger.add" | "ticket.add" | "note.append", "data": { ...fields for that action... }}}`;

// The output shape is instructed in the prompt rather than enforced with a
// compiled json_schema: the schema variant hit the API's "Grammar
// compilation timed out" error on every call. Parsing degrades safely — a
// response that isn't valid JSON is posted as a plain reply with no
// osUpdate, and a malformed osUpdate is dropped here (os-ingest and the
// database CHECK constraints re-validate anything that gets through anyway).
const OS_ACTIONS = ["ledger.add", "ticket.add", "note.append"];

function sanitizeOsUpdate(value: unknown): Json | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Json;
  if (typeof candidate.action !== "string" || !OS_ACTIONS.includes(candidate.action)) return null;
  if (typeof candidate.data !== "object" || candidate.data === null) return null;
  return { action: candidate.action, data: candidate.data };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("BRIDGE_SHARED_SECRET");
  if (!secret) return reply(500, { error: "BRIDGE_SHARED_SECRET is not set on this function" });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return reply(401, { error: "bad or missing bridge secret" });
  }
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return reply(500, {
      error: "ANTHROPIC_API_KEY is not set — add it to this project's Edge Function secrets",
    });
  }

  let payload: Json;
  try {
    payload = await req.json();
  } catch {
    return reply(400, { error: "body must be JSON" });
  }
  const instruction = payload.instruction;
  if (typeof instruction !== "string" || !instruction.trim()) {
    return reply(400, { error: "instruction is required" });
  }
  const context = Array.isArray(payload.context) ? payload.context : [];

  // Prior thread messages become a plain transcript above the instruction.
  const transcript = context
    .map((m: Json) => `${m.user}: ${m.text}`)
    .filter((line: string) => line.trim().length > 2)
    .join("\n");
  const userTurn = transcript
    ? `Earlier messages in this Slack thread:\n${transcript}\n\nInstruction: ${instruction}`
    : instruction;

  const anthropic = new Anthropic({ apiKey });
  try {
    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: userTurn }],
    });

    if (response.stop_reason === "refusal") {
      return reply(200, { reply: "I can't help with that request.", osUpdate: null });
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    if (response.stop_reason === "max_tokens" || !text) {
      return reply(200, {
        reply: "That answer ran too long for me to finish — try asking for something smaller.",
        osUpdate: null,
      });
    }
    let parsed: { reply?: unknown; osUpdate?: unknown };
    try {
      // Tolerate a fenced code block despite the no-fences instruction.
      const bare = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      parsed = JSON.parse(bare);
    } catch {
      // Not JSON — post it as a plain reply; never guess an OS update.
      return reply(200, { reply: text, osUpdate: null });
    }
    return reply(200, {
      reply: typeof parsed.reply === "string" ? parsed.reply : text,
      osUpdate: sanitizeOsUpdate(parsed.osUpdate),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply(502, { error: `Claude API call failed: ${message}` });
  }
});
