// weekly-insight: drafts a short market-insight note for a venture and files
// it through os-ingest as a PENDING PROPOSAL (note.append). The owner
// approves it on their phone and pastes the approved text into WhatsApp
// themselves — no WhatsApp API, deliberately.
//
// Fired weekly by pg_cron + pg_net (migration 003); can also be fired by
// hand with a plain POST. Auth: Bearer WEEKLY_JOB_SECRET — the pg_cron job
// reads that secret from Vault at each firing, this function reads its copy
// from the Edge Function secrets, and the two must match.
//
// The note is drafted with live web search (web_search tool) so "this week"
// means this actual week, not the model's training data. All writes still go
// through os-ingest — this function holds no service-role access; the only
// thing it can do to the OS is propose.
//
// Secrets (supabase function secrets): WEEKLY_JOB_SECRET, ANTHROPIC_API_KEY,
// OS_WEBHOOK_SECRET (already set for os-ingest), SUPABASE_URL (injected).

import Anthropic from "npm:@anthropic-ai/sdk";

type Json = Record<string, unknown>;

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROMPT = (venture: string) => `Search the web for the most relevant market developments of the past week, then draft this week's market-insight note for the venture "${venture}" at Godley Innovations.

Requirements for the note:
- Under 200 words, plain text only — no markdown, no headers, no emoji. It gets pasted directly into a WhatsApp group.
- Lead with the single most important development of the week and why it matters.
- One or two supporting points, each grounded in something you actually found this week.
- End with one clear, actionable takeaway.
- No preamble like "Here's this week's note" — start with the substance. Do not include URLs unless one is genuinely essential.

Your final message must contain ONLY the note text itself.`;

Deno.serve(async (req) => {
  const secret = Deno.env.get("WEEKLY_JOB_SECRET");
  if (!secret) return reply(500, { ok: false, error: "WEEKLY_JOB_SECRET is not set on this function" });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return reply(401, { ok: false, error: "bad or missing secret" });
  }
  if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return reply(500, {
      ok: false,
      error: "ANTHROPIC_API_KEY is not set — add it to this project's Edge Function secrets",
    });
  }
  const osSecret = Deno.env.get("OS_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!osSecret || !supabaseUrl) {
    return reply(500, { ok: false, error: "OS_WEBHOOK_SECRET / SUPABASE_URL missing from function env" });
  }

  let payload: Json = {};
  try {
    payload = await req.json();
  } catch {
    // Empty body is fine — everything has a default.
  }
  const venture = typeof payload.venture_slug === "string" && payload.venture_slug ? payload.venture_slug : "lil-bull";

  const anthropic = new Anthropic({ apiKey });
  let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: PROMPT(venture) }];
  let response;
  try {
    // Server-side web search runs its own loop; pause_turn means "re-send to
    // continue" — bounded so a wedged search can't spin forever.
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await anthropic.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
        messages,
      });
      if (response.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: response.content }];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply(502, { ok: false, error: `Claude API call failed: ${message}` });
  }

  if (!response || response.stop_reason === "refusal") {
    return reply(502, { ok: false, error: "the model declined to draft this note" });
  }

  // The note is the text after the last web-search result block (the final
  // answer); with no searches, it's all the text.
  let lastToolIdx = -1;
  response.content.forEach((block, i) => {
    if (block.type === "web_search_tool_result") lastToolIdx = i;
  });
  const note = response.content
    .slice(lastToolIdx + 1)
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  if (!note) return reply(502, { ok: false, error: "model returned no note text" });

  const ingest = await fetch(`${supabaseUrl}/functions/v1/os-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${osSecret}` },
    body: JSON.stringify({
      venture_slug: venture,
      action: "note.append",
      source: "weekly-insight",
      data: { text: note },
    }),
  });
  const ingestBody = await ingest.json().catch(() => ({}));
  if (!ingest.ok || ingestBody.ok === false) {
    return reply(502, {
      ok: false,
      error: `os-ingest rejected the proposal: ${ingestBody.error ?? ingest.status}`,
      note,
    });
  }

  return reply(200, { ok: true, proposal_id: ingestBody.id, venture_slug: venture, note });
});
