// Channel → venture routing. The convention is 1:1 by name: the Slack
// channel #lil-bull belongs to the venture whose slug is "lil-bull"
// (ventures.slug, migration 001 — lowercase letters, digits, hyphens, which
// is also exactly Slack's channel-name alphabet).
//
// Since migration 008 a venture also has an interaction_mode: 'hands_off'
// channels keep the original workroom behavior (messages logged, @mention =
// health probe); 'high_touch' channels route every owner message to the
// venture content agent (src/lib/content-agent.ts).

import { getSupabase } from "./supabase.js";

export type InteractionMode = "hands_off" | "high_touch";

export interface Venture {
  id: string;
  name: string;
  slug: string;
  status: string;
  interactionMode: InteractionMode;
  voicePrompt: string | null;
}

export function channelToVentureSlug(channelName: string): string {
  return channelName.replace(/^#/, "");
}

const VENTURE_COLS = "id, name, slug, status, interaction_mode, voice_prompt";

function normalizeVenture(raw: unknown): Venture | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.name !== "string" || typeof v.slug !== "string") return null;
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    status: typeof v.status === "string" ? v.status : "unknown",
    interactionMode: v.interaction_mode === "high_touch" ? "high_touch" : "hands_off",
    voicePrompt: typeof v.voice_prompt === "string" && v.voice_prompt.trim() ? v.voice_prompt : null,
  };
}

export async function resolveVenture(slug: string): Promise<Venture> {
  const { data, error } = await getSupabase()
    .from("ventures")
    .select(VENTURE_COLS)
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    throw new Error(`ventures lookup failed for slug "${slug}": ${error.message}`);
  }
  const venture = normalizeVenture(data);
  if (!venture) {
    throw new Error(
      `No venture matches slug "${slug}". The Slack channel name must equal a ` +
        `ventures.slug exactly (e.g. #lil-bull → lil-bull) — add the venture in ` +
        `the OS app or rename the channel.`,
    );
  }
  return venture;
}

// Per-event routing lookup: the venture behind a channel name, or null when
// the channel is not a venture (e.g. #studio-admin, #general). Cached
// briefly — every message in every channel the bot is in triggers it — and
// a lookup failure is logged and treated as "not a venture" so routing can
// never break event handling. (A missing migration 008 column surfaces
// here once; the channel then behaves as hands_off, which is the old
// behavior.)
const LOOKUP_TTL_MS = 5 * 60 * 1000;
const lookupCache = new Map<string, { at: number; venture: Venture | null }>();

export async function lookupVentureByChannelName(channelName: string): Promise<Venture | null> {
  const slug = channelToVentureSlug(channelName);
  const cached = lookupCache.get(slug);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.venture;
  let venture: Venture | null = null;
  try {
    const { data, error } = await getSupabase().from("ventures").select(VENTURE_COLS).eq("slug", slug).maybeSingle();
    if (error) throw new Error(error.message);
    venture = normalizeVenture(data);
  } catch (err) {
    console.error(`[venture-map] lookup of "${slug}" failed: ${err instanceof Error ? err.message : String(err)}`);
    return null; // not cached: the next event retries
  }
  lookupCache.set(slug, { at: Date.now(), venture });
  return venture;
}

// Test seam / cache reset (the sync action and the manager change modes
// rarely; five minutes of staleness is fine, but tests want determinism).
export function clearVentureLookupCache(): void {
  lookupCache.clear();
}
