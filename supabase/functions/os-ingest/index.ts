// os-ingest: the server-side write path into the Godley Innovations OS for
// trusted automation (today: the AI Mesh Bot's claude persona).
//
// Deploy:   supabase functions deploy os-ingest --no-verify-jwt
// Secret:   supabase secrets set OS_WEBHOOK_SECRET=<long random string>
//           (--no-verify-jwt because callers authenticate with that shared
//           secret, not a Supabase user JWT; the secret check below is the
//           gate, and it runs before anything else.)
//
// This function uses the service-role key (injected by Supabase, bypasses
// RLS). That is safe here and only here: this code runs server-side, the
// key never reaches a browser, and every request must present the shared
// secret first. Nothing in the frontend ever talks to this function.
//
// Payload contract (POST, Authorization: Bearer <OS_WEBHOOK_SECRET>):
//   { "venture_slug": "lil-bull",
//     "action": "ledger.add" | "ticket.add" | "note.append",
//     "data": { ... } }
//
//   ledger.add  data: { amount_cents (int, +in/-out), category?, occurred_on?,
//                       counterparty?, item?, note? }
//   ticket.add  data: { subject, customer?, channel?, opened_on? }
//   note.append data: { text }   -- appends a dated line to the venture's
//                                   notes; append-only so automation can
//                                   never erase what a human wrote.
//
// Allowed categories/columns are NOT re-validated here beyond basic shape:
// the database CHECK constraints are the single source of truth for what
// values are legal, and their errors are returned verbatim. Duplicating the
// lists here is exactly the two-places-disagree trap the OS is built to avoid.

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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const venture = await supabase
    .from("ventures")
    .select("id, notes, name")
    .eq("slug", ventureSlug)
    .maybeSingle();
  if (venture.error) return reply(500, { ok: false, error: venture.error.message });
  if (!venture.data) {
    return reply(404, { ok: false, error: `no venture with slug "${ventureSlug}"` });
  }
  const ventureId = venture.data.id as string;

  switch (action) {
    case "ledger.add": {
      if (!Number.isInteger(data.amount_cents)) {
        return reply(400, { ok: false, error: "data.amount_cents must be an integer (cents, +in/-out)" });
      }
      const { data: row, error } = await supabase
        .from("money_ledger")
        .insert({
          venture_id: ventureId,
          amount_cents: data.amount_cents,
          category: data.category ?? "other",
          occurred_on: data.occurred_on ?? undefined, // DB defaults to today
          counterparty: data.counterparty ?? null,
          item: data.item ?? null,
          note: data.note ?? null,
        })
        .select("id")
        .single();
      if (error) return reply(400, { ok: false, error: error.message });
      return reply(200, { ok: true, id: row.id });
    }

    case "ticket.add": {
      if (typeof data.subject !== "string" || !data.subject.trim()) {
        return reply(400, { ok: false, error: "data.subject is required" });
      }
      const { data: row, error } = await supabase
        .from("support_tickets")
        .insert({
          venture_id: ventureId,
          subject: data.subject.trim(),
          customer: data.customer ?? null,
          channel: data.channel ?? null,
          opened_on: data.opened_on ?? undefined,
        })
        .select("id")
        .single();
      if (error) return reply(400, { ok: false, error: error.message });
      return reply(200, { ok: true, id: row.id });
    }

    case "note.append": {
      if (typeof data.text !== "string" || !data.text.trim()) {
        return reply(400, { ok: false, error: "data.text is required" });
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const line = `[${stamp}] ${data.text.trim()}`;
      const existing = (venture.data.notes as string | null) ?? "";
      const { error } = await supabase
        .from("ventures")
        .update({ notes: existing ? `${existing}\n${line}` : line })
        .eq("id", ventureId);
      if (error) return reply(400, { ok: false, error: error.message });
      return reply(200, { ok: true });
    }

    default:
      return reply(400, {
        ok: false,
        error: `unknown action "${action}" (expected ledger.add, ticket.add, or note.append)`,
      });
  }
});
