import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { explainDbError } from "../lib/dbErrors";
import { formatCents } from "../lib/format";
import { ApprovalsCard } from "../components/ApprovalsCard";

interface VentureRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  thesis: string | null;
}

export const VENTURE_STATUSES = ["idea", "active", "paused", "dead"] as const;

// Slug is derived from the name — one fact, entered once. Changing the name
// later does NOT change the slug (URLs stay stable), which is why slug is
// still its own column.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function Home() {
  const [ventures, setVentures] = useState<VentureRow[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [thesis, setThesis] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("ventures")
      .select("id, name, slug, status, thesis")
      .order("created_at", { ascending: true });
    if (error) {
      setError(explainDbError(error));
    } else {
      setVentures((data ?? []) as VentureRow[]);
    }
    setLoading(false);

    // Cash balance per venture, derived from the ledger on every load — never
    // stored. If the ledger table is missing (migration not run yet) we just
    // skip balances; the registry itself keeps working.
    const led = await supabase!.from("money_ledger").select("venture_id, amount_cents");
    if (!led.error && led.data) {
      const sums: Record<string, number> = {};
      for (const r of led.data as { venture_id: string; amount_cents: number }[]) {
        sums[r.venture_id] = (sums[r.venture_id] ?? 0) + r.amount_cents;
      }
      setBalances(sums);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createVenture(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    const slug = slugify(name);
    if (!slug) {
      setError("The venture needs a name with at least one letter or number.");
      return;
    }
    setSaving(true);
    setError(null);
    const { error } = await supabase.from("ventures").insert({
      name: name.trim(),
      slug,
      thesis: thesis.trim() || null,
    });
    setSaving(false);
    if (error) {
      setError(explainDbError(error));
      return;
    }
    setName("");
    setThesis("");
    setFormOpen(false);
    await load();
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Godley Innovations Studio</h1>
        <button className="linklike" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <ApprovalsCard />

      <div className="card-head">
        <h2>Ventures</h2>
        <button onClick={() => setFormOpen(true)} disabled={formOpen}>
          + New venture
        </button>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {formOpen && (
        <form className="record-form card" onSubmit={createVenture}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>
          <label>
            Thesis (one line: what it is, why it exists)
            <input value={thesis} onChange={(e) => setThesis(e.target.value)} />
          </label>
          <div className="form-actions">
            <button disabled={saving}>{saving ? "Creating…" : "Create"}</button>
            <button type="button" className="linklike" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : ventures.length === 0 && !error ? (
        <p className="muted">
          No ventures yet. Create the first one — each venture gets its own
          workspace with financials, sales, advertising, social, websites and
          support.
        </p>
      ) : (
        <ul className="venture-list">
          {ventures.map((v) => (
            <li key={v.id}>
              <Link to={`/v/${v.slug}`} className="venture-card">
                <div className="venture-card-top">
                  <strong>{v.name}</strong>
                  <span className={`chip chip-${v.status}`}>{v.status}</span>
                </div>
                {v.thesis && <p className="muted">{v.thesis}</p>}
                <p className="venture-balance">
                  {v.id in balances ? formatCents(balances[v.id]) : "$0.00"}{" "}
                  <span className="muted">cash to date</span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
