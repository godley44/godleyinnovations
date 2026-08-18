// Supabase client on the SERVICE-ROLE key: it bypasses RLS, which is safe
// here and only here — this code runs server-side on Render, the key never
// reaches a browser, and every request that leads to a write has already
// passed Slack signature verification. Same reasoning as the os-ingest edge
// function (supabase/functions/os-ingest).
//
// Lazily created so the service can boot (and /health can answer) before the
// environment is fully configured; the first actual database call fails with
// a clear message instead of the process crashing at import time.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  }
  client = createClient(url, key, {
    // No user sessions here — this is a server with a static key.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
