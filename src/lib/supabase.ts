import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The anon key and URL are Vercel env vars (VITE_ prefix = bundled into the
// browser, which is fine: the anon key is public by design and RLS is the
// real lock). Secrets that must NOT reach the browser (service keys, API
// tokens) never get a VITE_ prefix and only ever live in server functions.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Exported as possibly-null instead of throwing at import time: a fresh
// deploy without env vars must render a setup screen, not a blank page.
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

export const missingEnvVars: string[] = [
  ...(url ? [] : ["VITE_SUPABASE_URL"]),
  ...(anonKey ? [] : ["VITE_SUPABASE_ANON_KEY"]),
];
