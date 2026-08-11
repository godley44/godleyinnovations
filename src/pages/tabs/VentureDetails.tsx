import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { explainDbError } from "../../lib/dbErrors";
import { VENTURE_STATUSES } from "../Home";
import type { VentureRecord } from "../Venture";

// Edit the venture's own facts (name, status, thesis, notes). The slug is
// deliberately not editable: it is this venture's stable address, and every
// child record points at the id anyway.
export function VentureDetails({
  venture,
  onChanged,
}: {
  venture: VentureRecord;
  onChanged: () => Promise<void> | void;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(venture.name);
  const [status, setStatus] = useState(venture.status);
  const [thesis, setThesis] = useState(venture.thesis ?? "");
  const [notes, setNotes] = useState(venture.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setSaving(true);
    setError(null);
    const { error } = await supabase
      .from("ventures")
      .update({
        name: name.trim(),
        status,
        thesis: thesis.trim() || null,
        notes: notes.trim() || null,
      })
      .eq("id", venture.id);
    setSaving(false);
    if (error) {
      setError(explainDbError(error));
      return;
    }
    setEditing(false);
    await onChanged();
  }

  async function removeVenture() {
    if (!supabase) return;
    const confirmed = window.prompt(
      `Deleting "${venture.name}" also deletes ALL its records on every tab ` +
        `(ledger entries, tickets, campaigns, everything). Type the venture ` +
        `name to confirm:`,
    );
    if (confirmed !== venture.name) return;
    const { error } = await supabase.from("ventures").delete().eq("id", venture.id);
    if (error) {
      setError(explainDbError(error));
      return;
    }
    navigate("/");
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>Venture details</h3>
        {!editing && (
          <button onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>
      {error && <p className="error-banner">{error}</p>}
      {editing ? (
        <form className="record-form" onSubmit={save}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {VENTURE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Thesis
            <input value={thesis} onChange={(e) => setThesis(e.target.value)} />
          </label>
          <label>
            Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
          </label>
          <div className="form-actions">
            <button disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className="linklike" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="linklike danger" onClick={() => void removeVenture()}>
              Delete venture…
            </button>
          </div>
        </form>
      ) : (
        <>
          {venture.notes ? (
            <p className="prewrap">{venture.notes}</p>
          ) : (
            <p className="muted">No notes yet. Use notes for context you’d otherwise re-explain from scratch: what stage this is at, what you decided and why.</p>
          )}
        </>
      )}
    </section>
  );
}
