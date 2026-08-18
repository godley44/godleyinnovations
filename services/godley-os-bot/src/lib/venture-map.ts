// Channel → venture routing. The convention is 1:1 by name: the Slack
// channel #lil-bull belongs to the venture whose slug is "lil-bull"
// (ventures.slug, migration 001 — lowercase letters, digits, hyphens, which
// is also exactly Slack's channel-name alphabet).

import { getSupabase } from "./supabase.js";

export interface Venture {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export function channelToVentureSlug(channelName: string): string {
  return channelName.replace(/^#/, "");
}

export async function resolveVenture(slug: string): Promise<Venture> {
  const { data, error } = await getSupabase()
    .from("ventures")
    .select("id, name, slug, status")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    throw new Error(`ventures lookup failed for slug "${slug}": ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `No venture matches slug "${slug}". The Slack channel name must equal a ` +
        `ventures.slug exactly (e.g. #lil-bull → lil-bull) — add the venture in ` +
        `the OS app or rename the channel.`,
    );
  }
  return data as Venture;
}
