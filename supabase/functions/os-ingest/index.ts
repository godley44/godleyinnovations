// os-ingest: the server-side entry point into the Godley Innovations OS for
// trusted automation (today: the AI Mesh Bot's claude persona).
//
// Since migration 002, this function does NOT write to the ledger, tickets,
// or notes directly. It files a PROPOSAL row; the owner approves or rejects
// it in the app, and approval (apply_proposal in the database) is what
// actually writes. Automation drafts, the human signs — that boundary is the
// point, don't route around it.
//
// Deploy:   supabase functions deploy os-ingest --no-verify-jwt
// Secret:   supabase secrets set OS_WEBHOOK_SECRET=<long random string>
//           (--no-verify-jwt because callers authenticate with that shared
//           secret, not a Supabase user JWT; the secret check below is the
//           gate, and it runs before anything else.)
//
// The service-role key (injected by Supabase, bypasses RLS) is used only to
// insert the proposal row. That is safe here and only here: this code runs
// server-side, the key never reaches a browser, and every request must
// present the shared secret first.
//
// Payload contract (POST, Authorization: Bearer <OS_WEBHOOK_SECRET>):
//   { "venture_slug": "lil-bull",
//     "action": "ledger.add" | "ticket.add" | "note.append",
//     "source": "optional label of who proposed this (defaults 'automation')",
//     "data": { ... } }
//
//   ledger.add  data: { amount_cents (int, +in/-out), category?, occurred_on?,
//                       counterparty?, item?, note? }
//   ticket.add  data: { subject, customer?, channel?, opened_on? }
//   note.append data: { text }
//
// Shape is validated here so a garbage proposal is rejected at the door with
// a clear error; VALUE rules (allowed categories etc.) are not duplicated
// here — the database CHECK constraints stay the single source of truth and
// reject bad values at approval time.

import { createClient } from "npm:@supabase/supabase-js@2";

type Json = Record<string, unknown>;

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("OS_WEBHOOK_SECRET");
  if (!secret) return reply(500, { ok: false, error: "OS_WEBHOOK_SECRET is not set on this function" });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return reply(401, { ok: false, error: "bad or missing secret" });
  }
  if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });

  let payload: Json;
  try {
    payload = await req.json();
  } catch {
    return reply(400, { ok: false, error: "body must be JSON" });
  }

  const ventureSlug = payload.venture_slug;
  const action = payload.action;
  const data = (payload.data ?? {}) as Json;
  if (typeof ventureSlug !== "string" || typeof action !== "string") {
    return reply(400, { ok: false, error: "venture_slug and action are required" });
  }

  // Shape checks per action — catch broken automation immediately instead of
  // filing a proposal that can never be applied.
  if (action === "ledger.add" && !Number.isInteger(data.amount_cents)) {
    return reply(400, { ok: false, error: "data.amount_cents must be an integer (cents, +in/-out)" });
  }
  if (action === "ticket.add" && (typeof data.subject !== "string" || !data.subject.trim())) {
    return reply(400, { ok: false, error: "data.subject is required" });
  }
  if (action === "note.append" && (typeof data.text !== "string" || !data.text.trim())) {
    return reply(400, { ok: false, error: "data.text is required" });
  }
  if (!["ledger.add", "ticket.add", "note.append"].includes(action)) {
    return reply(400, {
      ok: false,
      error: `unknown action "${action}" (expected ledger.add, ticket.add, or note.append)`,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const venture = await supabase
    .from("ventures")
    .select("id, name")
    .eq("slug", ventureSlug)
    .maybeSingle();
  if (venture.error) return reply(500, { ok: false, error: venture.error.message });
  if (!venture.data) {
    return reply(404, { ok: false, error: `no venture with slug "${ventureSlug}"` });
  }

  const { data: row, error } = await supabase
    .from("proposals")
    .insert({
      venture_id: venture.data.id,
      action,
      payload: data,
      proposed_by: typeof payload.source === "string" && payload.source ? payload.source : "automation",
    })
    .select("id")
    .single();

  if (error) {
    // The function can be deployed ahead of the database (deploys and
    // migrations are both manual, in either order). Say exactly what to do.
    if (error.code === "42P01") {
      return reply(500, {
        ok: false,
        error: "the proposals table doesn't exist yet — run supabase/migrations/002_proposals.sql in the SQL editor",
      });
    }
    return reply(400, { ok: false, error: error.message });
  }

  return reply(200, {
    ok: true,
    id: row.id,
    status: "pending",
    note: `proposal filed for "${venture.data.name}" — awaiting approval in the OS app`,
  });
});
