import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { explainDbError } from "../lib/dbErrors";

// The Weekly Brief card: the most recent APPROVED weekly-insight note for a
// venture, full text, with one-tap copy for WhatsApp. Reads the proposals
// table (approved only — the approvals gate stays the single write path;
// this card is a lens, not a pipeline). History expands to prior briefs.

interface BriefRow {
  id: string;
  payload: Record<string, unknown>;
  decided_at: string | null;
  created_at: string;
}

function briefDate(row: BriefRow): string {
  return new Date(row.decided_at ?? row.created_at).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function WeeklyBriefCard({ ventureId }: { ventureId: string }) {
  const [rows, setRows] = useState<BriefRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("proposals")
      .select("id, payload, decided_at, created_at")
      .eq("venture_id", ventureId)
      .eq("proposed_by", "weekly-insight")
      .eq("action", "note.append")
      .eq("status", "approved")
      .order("decided_at", { ascending: false })
      .limit(12);
    if (error) {
      setError(explainDbError(error));
    } else {
      setError(null);
      setRows((data ?? []) as BriefRow[]);
    }
    setLoaded(true);
  }, [ventureId]);

  useEffect(() => {
    void load();
    if (!supabase) return;
    const channel = supabase
      .channel(`briefs-${ventureId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "proposals" }, () => void load())
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

  async function copy(row: BriefRow) {
    // The payload text is stored exactly as assembled by weekly-insight —
    // plain text, WhatsApp-ready. Copy it verbatim, no re-formatting.
    const text = String(row.payload.text ?? "");
    try {
      await navigator.clipboard.writeText(text);
      setCopyError(false);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopyError(true);
    }
  }

  const latest = rows[0];
  const history = rows.slice(1);

  return (
    <section className="card brief-card">
      <div className="brief-head">
        <h3>Weekly Brief</h3>
        {latest && (
          <button onClick={() => void copy(latest)}>
            {copiedId === latest.id ? "Copied ✓" : "Copy"}
          </button>
        )}
      </div>
      {error && <p className="error-banner">{error}</p>}
      {copyError && (
        <p className="muted">Couldn't reach the clipboard — long-press the text to select it.</p>
      )}
      {loaded && !latest && !error && <p className="muted">No brief yet — next run Monday.</p>}
      {latest && (
        <>
          <p className="muted brief-date">Approved {briefDate(latest)}</p>
          <p className="prewrap brief-text">{String(latest.payload.text ?? "")}</p>
        </>
      )}
      {history.length > 0 && (
        <details className="brief-history">
          <summary>
            Previous briefs ({history.length})
          </summary>
          <ul className="brief-history-list">
            {history.map((row) => (
              <li key={row.id}>
                <div className="brief-head">
                  <p className="muted brief-date">{briefDate(row)}</p>
                  <button className="linklike" onClick={() => void copy(row)}>
                    {copiedId === row.id ? "Copied ✓" : "Copy"}
                  </button>
                </div>
                <p className="prewrap brief-text">{String(row.payload.text ?? "")}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
