// THE account-sync code path — shared by POST /admin/blotato-accounts/sync
// and the AI Manager's sync_blotato_accounts action (after the owner's
// "yes"), so the phone-only owner never needs the SQL editor to wire a
// venture's Blotato accounts.
//
// With THIS venture's key only: list the connected accounts, pick its
// Instagram and Facebook accounts, fetch the Facebook Page id (a
// subaccount), and upsert venture_platforms rows for the venture. Nothing
// here publishes or touches another venture's rows — the key resolution in
// the Blotato client is what makes "another venture's accounts" impossible.
// Ambiguity (two Instagram accounts, two Pages) is reported, never guessed.

import { listAccounts, listSubaccounts, resolveBlotatoKey, ventureKeyName } from "../integrations/blotato.js";
import { CONTENT_PLATFORMS } from "./content-publish.js";
import { getSupabase } from "./supabase.js";

export interface SyncedPlatform {
  platform: string;
  accountId: string;
  pageId: string | null;
  label: string; // "@handle" / page name, for the reply
}

export interface SkippedPlatform {
  platform: string;
  reason: string;
}

export interface SyncResult {
  ok: true;
  venture: { id: string; slug: string; name: string };
  synced: SyncedPlatform[];
  skipped: SkippedPlatform[];
}

export interface SyncRefused {
  ok: false;
  status: number;
  error: string;
}

export async function syncBlotatoAccounts(ventureSlug: string): Promise<SyncResult | SyncRefused> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("ventures").select("id, slug, name").eq("slug", ventureSlug).maybeSingle();
  if (error) return { ok: false, status: 500, error: `ventures query failed: ${error.message}` };
  if (!data) return { ok: false, status: 404, error: `no venture with slug "${ventureSlug}"` };
  const venture = data as { id: string; slug: string; name: string };

  if (resolveBlotatoKey(ventureSlug).key === null) {
    return {
      ok: false,
      status: 409,
      error: `${ventureKeyName(ventureSlug)} is not set (or is the "pending" placeholder) — paste this venture's Blotato key into Doppler first`,
    };
  }

  let accounts: Awaited<ReturnType<typeof listAccounts>>;
  try {
    accounts = await listAccounts(ventureSlug);
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }

  const synced: SyncedPlatform[] = [];
  const skipped: SkippedPlatform[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const platform of CONTENT_PLATFORMS) {
    const matches = accounts.filter((a) => a.platform.toLowerCase() === platform);
    if (matches.length === 0) {
      skipped.push({ platform, reason: `no ${platform} account is connected to this Blotato workspace — connect it in Blotato, then sync again` });
      continue;
    }
    if (matches.length > 1) {
      skipped.push({
        platform,
        reason: `${matches.length} ${platform} accounts are connected (${matches.map((m) => `@${m.username || m.id}`).join(", ")}) — disconnect the extra one in Blotato, then sync again`,
      });
      continue;
    }
    const account = matches[0]!;
    let pageId: string | null = null;
    let label = account.username ? `@${account.username}` : account.fullname || account.id;
    if (platform === "facebook") {
      let pages: Awaited<ReturnType<typeof listSubaccounts>>;
      try {
        pages = await listSubaccounts(ventureSlug, account.id);
      } catch (err) {
        skipped.push({ platform, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (pages.length === 0) {
        skipped.push({ platform, reason: "the Facebook account has no Page connected — Facebook publishes to a Page; connect one in Blotato, then sync again" });
        continue;
      }
      if (pages.length > 1) {
        skipped.push({
          platform,
          reason: `${pages.length} Facebook Pages are connected (${pages.map((p) => p.name || p.id).join(", ")}) — keep the one this venture publishes to, then sync again`,
        });
        continue;
      }
      pageId = pages[0]!.id;
      label = `${label} · Page "${pages[0]!.name || pageId}"`;
    }
    rows.push({ venture_id: venture.id, platform, blotato_account_id: account.id, blotato_page_id: pageId, enabled: true });
    synced.push({ platform, accountId: account.id, pageId, label });
  }

  if (rows.length > 0) {
    const { error: upsertError } = await supabase.from("venture_platforms").upsert(rows, { onConflict: "venture_id,platform" });
    if (upsertError) return { ok: false, status: 500, error: `venture_platforms upsert failed: ${upsertError.message}` };
  }
  return { ok: true, venture, synced, skipped };
}

export function describeSyncResult(result: SyncResult): string {
  const lines = result.synced.map((s) => `• ${s.platform}: ${s.label} (account ${s.accountId}${s.pageId ? `, page ${s.pageId}` : ""}) ✅`);
  for (const s of result.skipped) lines.push(`• ${s.platform}: ⚠️ ${s.reason}`);
  return lines.join("\n") || "nothing to sync";
}
