import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { explainDbError } from "../lib/dbErrors";
import { formatCents } from "../lib/format";

// The approvals inbox. Everything automation wants to write into the OS
// lands here as a pending proposal; approving calls apply_proposal() in the
// database, which does the actual write and flips the status in one
// transaction. Nothing an agent produces touches the books until a human
// taps Approve — that boundary is the reason this card exists.

interface Proposal {
  id: string;
  venture_id: string;
  action: string;
  payload: Record<string, unknown>;
  proposed_by: string;
  status: string;
  created_at: string;
  ventures: { name: string; slug: string } | null;
}

function describe(p: Proposal): string {
  const d = p.payload;
  switch (p.action) {
    case "ledger.add": {
      const cents = typeof d.amount_cents === "number" ? d.amount_cents : 0;
      const dir = cents >= 0 ? "in" : "out";
      const bits = [
        `${formatCents(cents)} ${dir}`,
        d.category ? `(${String(d.category)})` : null,
        d.counterparty ? `— ${String(d.counterparty)}` : null,
        d.item ? `· ${String(d.item)}` : null,
      ].filter(Boolean);
      return `Ledger entry: ${bits.join(" ")}`;
    }
    case "ticket.add":
      return `Open ticket: ${String(d.subject ?? "")}${d.customer ? ` (from ${String(d.customer)})` : ""}`;
    case "note.append":
      return `Add note: ${String(d.text ?? "")}`;
    default:
      // Unknown action: still shown (never hidden), just raw. apply_proposal
      // will refuse it with a clear error if approved.
      return `${p.action}: ${JSON.stringify(d)}`;
  }
}

export function ApprovalsCard({ ventureId }: { ventureId?: string }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    let query = supabase
      .from("proposals")
      .select("*, ventures(name, slug)")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (ventureId) query = query.eq("venture_id", ventureId);
    const { data, error } = await query;
    if (error) {
      // Migration 002 not run yet: this whole feature quietly doesn't exist
      // rather than shouting on every screen — the card explains itself only
      // if there are no other problems worth the space.
      setError(error.code === "42P01" ? null : explainDbError(error));
      setProposals([]);
    } else {
      setError(null);
      setProposals((data ?? []) as Proposal[]);
    }
    setLoaded(true);
  }, [ventureId]);

  useEffect(() => {
    void load();

    if (!supabase) return;
    // Realtime: a proposal filed from Slack should appear on the phone while
    // you're looking at the screen. Best-effort — if the subscription drops,
    // the visibilitychange refetch below still keeps the list honest every
    // time the phone screen comes back to this app.
    const channel = supabase
      .channel(`proposals-${ventureId ?? "all"}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "proposals" },
        () => void load(),
      )
      .subscribe();

    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      void supabase?.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, ventureId]);

  async function approve(p: Proposal) {
    if (!supabase) return;
    setBusyId(p.id);
    setError(null);
    const { error } = await supabase.rpc("apply_proposal", { p_id: p.id });
    setBusyId(null);
    if (error) {
      setError(explainDbError(error));
      return;
    }
    await load();
  }

  async function reject(p: Proposal) {
    if (!supabase) return;
    setBusyId(p.id);
    setError(null);
    const { error } = await supabase
      .from("proposals")
      .update({ status: "rejected", decided_at: new Date().toISOString() })
      .eq("id", p.id)
      .eq("status", "pending"); // never flip an already-decided proposal
    setBusyId(null);
    if (error) {
      setError(explainDbError(error));
      return;
    }
    await load();
  }

  // No pending items and no error: render nothing. The inbox earns screen
  // space only when there is a decision to make.
  if (loaded && proposals.length === 0 && !error) return null;

  return (
    <section className="card approvals">
      <h3>
        Needs your approval{" "}
        {proposals.length > 0 && <span className="chip chip-paused">{proposals.length}</span>}
      </h3>
      {error && <p className="error-banner">{error}</p>}
      <ul className="approval-list">
        {proposals.map((p) => (
          <li key={p.id} className="approval-item">
            <div>
              <p className="approval-desc">{describe(p)}</p>
              <p className="muted approval-meta">
                {!ventureId && p.ventures ? `${p.ventures.name} · ` : ""}
                proposed by {p.proposed_by}
              </p>
            </div>
            <div className="approval-actions">
              <button disabled={busyId === p.id} onClick={() => void approve(p)}>
                Approve
              </button>
              <button
                className="linklike danger"
                disabled={busyId === p.id}
                onClick={() => void reject(p)}
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
