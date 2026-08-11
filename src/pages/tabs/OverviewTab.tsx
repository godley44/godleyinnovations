import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { formatCents } from "../../lib/format";

// Every number on this screen is computed from the module tables at load
// time. Nothing here is stored anywhere — that is the point: the overview
// can be wrong only if the underlying records are wrong, never on its own.
//
// Each stat loads independently: if one table is missing (its migration
// hasn't been run yet) that stat shows an em dash and the rest still work.

interface Stats {
  cashBalance?: number;
  in30?: number;
  out30?: number;
  revenueTotal?: number;
  adSpendTotal?: number;
  openTickets?: number;
  liveSites?: number;
  followers?: number;
  runningCampaigns?: number;
}

export function OverviewTab({ ventureId }: { ventureId: string }) {
  const [stats, setStats] = useState<Stats>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadStats() {
      if (!supabase) return;
      const next: Stats = {};
      const today = new Date();
      const cutoff = new Date(today.getTime() - 30 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);

      const ledger = await supabase
        .from("money_ledger")
        .select("amount_cents, category, occurred_on")
        .eq("venture_id", ventureId);
      if (!ledger.error && ledger.data) {
        const rows = ledger.data as {
          amount_cents: number;
          category: string;
          occurred_on: string;
        }[];
        next.cashBalance = rows.reduce((s, r) => s + r.amount_cents, 0);
        next.in30 = rows
          .filter((r) => r.occurred_on >= cutoff && r.amount_cents > 0)
          .reduce((s, r) => s + r.amount_cents, 0);
        next.out30 = rows
          .filter((r) => r.occurred_on >= cutoff && r.amount_cents < 0)
          .reduce((s, r) => s + r.amount_cents, 0);
        next.revenueTotal = rows
          .filter((r) => r.category === "sale")
          .reduce((s, r) => s + r.amount_cents, 0);
        next.adSpendTotal = rows
          .filter((r) => r.category === "advertising")
          .reduce((s, r) => s + r.amount_cents, 0);
      }

      const tickets = await supabase
        .from("support_tickets")
        .select("id", { count: "exact", head: true })
        .eq("venture_id", ventureId)
        .neq("status", "closed");
      if (!tickets.error) next.openTickets = tickets.count ?? 0;

      const sites = await supabase
        .from("websites")
        .select("id", { count: "exact", head: true })
        .eq("venture_id", ventureId)
        .eq("status", "live");
      if (!sites.error) next.liveSites = sites.count ?? 0;

      const todayIso = today.toISOString().slice(0, 10);
      const camps = await supabase
        .from("ad_campaigns")
        .select("starts_on, ends_on")
        .eq("venture_id", ventureId);
      if (!camps.error && camps.data) {
        // "Running" is derived from dates — campaigns have no status column
        // on purpose (see migration 001).
        next.runningCampaigns = (
          camps.data as { starts_on: string; ends_on: string | null }[]
        ).filter((c) => c.starts_on <= todayIso && (!c.ends_on || c.ends_on >= todayIso)).length;
      }

      const accounts = await supabase
        .from("social_accounts")
        .select("id")
        .eq("venture_id", ventureId);
      if (!accounts.error && accounts.data && accounts.data.length > 0) {
        const ids = (accounts.data as { id: string }[]).map((a) => a.id);
        const snaps = await supabase
          .from("social_snapshots")
          .select("account_id, taken_on, follower_count")
          .in("account_id", ids)
          .order("taken_on", { ascending: false });
        if (!snaps.error && snaps.data) {
          // Latest snapshot per account, summed.
          const latest = new Map<string, number>();
          for (const s of snaps.data as {
            account_id: string;
            follower_count: number;
          }[]) {
            if (!latest.has(s.account_id)) latest.set(s.account_id, s.follower_count);
          }
          next.followers = [...latest.values()].reduce((a, b) => a + b, 0);
        }
      } else if (!accounts.error) {
        next.followers = 0;
      }

      if (!cancelled) {
        setStats(next);
        setLoading(false);
      }
    }
    void loadStats();
    return () => {
      cancelled = true;
    };
  }, [ventureId]);

  const cents = (v: number | undefined) => (v == null ? "—" : formatCents(v));
  const num = (v: number | undefined) => (v == null ? "—" : String(v));

  return (
    <section className="card">
      <h3>Overview {loading && <span className="muted">(loading…)</span>}</h3>
      <div className="stat-grid">
        <Stat label="Cash to date" value={cents(stats.cashBalance)} />
        <Stat label="In, last 30 days" value={cents(stats.in30)} />
        <Stat label="Out, last 30 days" value={cents(stats.out30)} />
        <Stat label="Revenue, all time" value={cents(stats.revenueTotal)} />
        <Stat label="Ad spend, all time" value={cents(stats.adSpendTotal)} />
        <Stat label="Open tickets" value={num(stats.openTickets)} />
        <Stat label="Live sites" value={num(stats.liveSites)} />
        <Stat label="Followers (latest)" value={num(stats.followers)} />
        <Stat label="Campaigns running" value={num(stats.runningCampaigns)} />
      </div>
      <p className="muted">
        Every number here is computed from the tabs’ records right now — nothing
        is stored twice. A dash means that table’s migration hasn’t been run yet.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
