import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { FieldSpec, SectionSpec } from "../modules/types.ts";
import { supabase } from "../lib/supabase";
import { explainDbError } from "../lib/dbErrors";
import { dollarsToCents, formatCents, formatDate, todayISO } from "../lib/format";

// One component renders every list-of-records section in the app (ledger,
// tickets, campaigns, accounts...). It is driven entirely by SectionSpec so
// behavior stays identical across modules and the guard script can reason
// about all of them. Errors are translated (see dbErrors) and confined to
// this section: a missing table takes down one card, never the app.

export interface Row {
  id: string;
  [key: string]: unknown;
}

export function RecordSection({
  ventureId,
  spec,
  onRowsChange,
}: {
  ventureId: string;
  spec: SectionSpec;
  onRowsChange?: (rows: Row[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [parents, setParents] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const viaScope = spec.scope !== "venture" ? spec.scope.via : null;

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      let parentRows: Row[] = [];
      if (viaScope) {
        // Child tables (e.g. snapshots) don't carry venture_id — the venture
        // is reachable through the parent, stored once. Resolve parents first.
        const p = await supabase
          .from(viaScope.parentTable)
          .select("*")
          .eq("venture_id", ventureId);
        if (p.error) throw p.error;
        parentRows = (p.data ?? []) as Row[];
        setParents(parentRows);
      }

      let query = supabase.from(spec.table).select("*");
      if (viaScope) {
        const ids = parentRows.map((r) => r.id);
        if (ids.length === 0) {
          setRows([]);
          onRowsChange?.([]);
          setLoading(false);
          return;
        }
        query = query.in(viaScope.fkColumn, ids);
      } else {
        query = query.eq("venture_id", ventureId);
      }
      for (const [col, val] of Object.entries(spec.fixed ?? {})) {
        query = query.eq(col, val);
      }
      const { data, error } = await query.order(spec.orderBy.column, {
        ascending: spec.orderBy.ascending,
      });
      if (error) throw error;
      const loaded = (data ?? []) as Row[];
      setRows(loaded);
      onRowsChange?.(loaded);
    } catch (err) {
      setError(explainDbError(err));
    } finally {
      setLoading(false);
    }
  }, [ventureId, spec, viaScope, onRowsChange]);

  useEffect(() => {
    void load();
  }, [load]);

  function emptyForm(): Record<string, string> {
    const f: Record<string, string> = {};
    for (const field of spec.fields) {
      if (field.type === "date") f[field.key] = todayISO();
      else f[field.key] = "";
      if (field.type === "money" && field.moneyDirection === "signed") {
        f[`${field.key}__direction`] = "in";
      }
    }
    return f;
  }

  function openCreate() {
    setForm(emptyForm());
    setEditingId(null);
    setFormOpen(true);
  }

  function openEdit(row: Row) {
    const f: Record<string, string> = {};
    for (const field of spec.fields) {
      const v = row[field.key];
      if (field.type === "money") {
        const cents = typeof v === "number" ? v : 0;
        f[field.key] = v == null ? "" : (Math.abs(cents) / 100).toFixed(2);
        if (field.moneyDirection === "signed") {
          f[`${field.key}__direction`] = cents < 0 ? "out" : "in";
        }
      } else {
        f[field.key] = v == null ? "" : String(v);
      }
    }
    setForm(f);
    setEditingId(row.id);
    setFormOpen(true);
  }

  function buildPayload(): Record<string, unknown> | string {
    const payload: Record<string, unknown> = {};
    for (const field of spec.fields) {
      const raw = (form[field.key] ?? "").trim();
      if (raw === "") {
        if (field.required) return `"${field.label}" is required.`;
        payload[field.key] = null;
        continue;
      }
      if (field.type === "money") {
        const cents = dollarsToCents(raw);
        if (cents == null) return `"${field.label}" must be a dollar amount.`;
        const dir =
          field.moneyDirection === "signed"
            ? form[`${field.key}__direction`]
            : field.moneyDirection;
        payload[field.key] = dir === "out" ? -Math.abs(cents) : Math.abs(cents);
      } else if (field.type === "number") {
        const n = Number(raw);
        if (Number.isNaN(n)) return `"${field.label}" must be a number.`;
        payload[field.key] = n;
      } else {
        payload[field.key] = raw;
      }
    }
    // Fixed values are the "lens" (e.g. category='sale' on the Sales tab):
    // applied on every write so a row can never land outside its lens.
    Object.assign(payload, spec.fixed ?? {});
    if (!viaScope) payload.venture_id = ventureId;
    return payload;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    const payload = buildPayload();
    if (typeof payload === "string") {
      setError(payload);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const q = editingId
        ? supabase.from(spec.table).update(payload).eq("id", editingId)
        : supabase.from(spec.table).insert(payload);
      const { error } = await q;
      if (error) throw error;
      setFormOpen(false);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(explainDbError(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: Row) {
    if (!supabase) return;
    if (!window.confirm("Delete this record? This cannot be undone.")) return;
    setError(null);
    try {
      const { error } = await supabase.from(spec.table).delete().eq("id", row.id);
      if (error) throw error;
      await load();
    } catch (err) {
      setError(explainDbError(err));
    }
  }

  function parentLabel(id: unknown): string {
    const p = parents.find((r) => r.id === id);
    if (!p) return String(id ?? "");
    // Best-effort human label for a parent row; covers social_accounts
    // (platform + handle) and any future parent with name/label.
    const name = (p.handle ?? p.name ?? p.label ?? p.id) as string;
    const prefix = p.platform ? `${String(p.platform)} · ` : "";
    return `${prefix}${name}`;
  }

  function displayValue(row: Row, field: FieldSpec): string {
    const v = row[field.key];
    if (v == null || v === "") return "—";
    if (field.type === "money") return formatCents(v as number);
    if (field.type === "date") return formatDate(String(v));
    if (viaScope && field.key === viaScope.fkColumn) return parentLabel(v);
    return String(v);
  }

  function fieldOptions(field: FieldSpec): { value: string; label: string }[] {
    if (viaScope && field.key === viaScope.fkColumn) {
      return parents.map((p) => ({ value: p.id, label: parentLabel(p.id) }));
    }
    return (field.options ?? []).map((o) => ({ value: o, label: o }));
  }

  const parentMissing = viaScope !== null && parents.length === 0 && !loading && !error;

  return (
    <section className="card">
      <div className="card-head">
        <h3>{spec.title}</h3>
        {!parentMissing && (
          <button onClick={openCreate} disabled={formOpen && !editingId}>
            + Add
          </button>
        )}
      </div>

      {error && <p className="error-banner">{error}</p>}

      {formOpen && (
        <form className="record-form" onSubmit={save}>
          {spec.fields.map((field) => (
            <label key={field.key}>
              {field.label}
              {field.type === "select" ? (
                <select
                  value={form[field.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                  required={field.required}
                >
                  <option value="">— pick —</option>
                  {fieldOptions(field).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "longtext" ? (
                <textarea
                  value={form[field.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                  rows={2}
                />
              ) : field.type === "money" && field.moneyDirection === "signed" ? (
                <span className="money-signed">
                  <select
                    value={form[`${field.key}__direction`] ?? "in"}
                    onChange={(e) =>
                      setForm({ ...form, [`${field.key}__direction`]: e.target.value })
                    }
                  >
                    <option value="in">in +</option>
                    <option value="out">out −</option>
                  </select>
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={form[field.key] ?? ""}
                    onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                    required={field.required}
                  />
                </span>
              ) : (
                <input
                  type={field.type === "date" ? "date" : field.type === "url" ? "url" : "text"}
                  inputMode={
                    field.type === "money" || field.type === "number" ? "decimal" : undefined
                  }
                  placeholder={field.placeholder}
                  value={form[field.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                  required={field.required}
                />
              )}
            </label>
          ))}
          <div className="form-actions">
            <button disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Add"}
            </button>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setFormOpen(false);
                setEditingId(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : parentMissing ? (
        <p className="muted">Add an entry in “{spec.title === "Follower snapshots" ? "Accounts" : "the section above"}” first — records here attach to those.</p>
      ) : rows.length === 0 ? (
        <p className="muted">{spec.emptyHint}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {spec.fields.map((f) => (
                  <th key={f.key}>{f.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {spec.fields.map((f) => (
                    <td key={f.key} className={f.type === "money" ? "num" : undefined}>
                      {f.type === "url" && row[f.key] ? (
                        <a href={String(row[f.key])} target="_blank" rel="noreferrer">
                          {String(row[f.key])}
                        </a>
                      ) : (
                        displayValue(row, f)
                      )}
                    </td>
                  ))}
                  <td className="row-actions">
                    <button className="linklike" onClick={() => openEdit(row)}>
                      Edit
                    </button>
                    <button className="linklike danger" onClick={() => void remove(row)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
