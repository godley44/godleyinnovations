import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { explainDbError } from "../lib/dbErrors";
import { formatCents } from "../lib/format";

// The approvals inbox. Everything automation wants to write into the OS
// lands here as a pending proposal; approving calls apply_proposal() in the
// database, which does the actual write and flips the status in one
// transaction. Nothing an agent produces touches the books until a human
// taps Approve — that boundary is the reason this card exists.
//
// The section is ALWAYS visible (empty state included) so the inbox has a
// fixed home the thumb can find — it used to render nothing when empty,
// which read as "this feature doesn't exist".

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

function summarize(p: Proposal): string {
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
      return "Add note:";
    case "whatsapp.message":
      return "WhatsApp message (hand-off to Slack after approval):";
    case "video.script":
      return `Video script — "${String(d.title ?? "")}" (narration + assembly start after approval):`;
    case "social.post": {
      const targets = socialTargets(d);
      const where =
        targets.length > 0
          ? targets.map((t) => `${t.name} (${t.platforms.map(platformLabel).join(", ") || "no platform"})`).join("; ")
          : Array.isArray(d.platforms)
            ? (d.platforms as unknown[]).filter((p): p is string => typeof p === "string").map(platformLabel).join(", ")
            : "the venture's platforms";
      return d.kind === "video"
        ? `Publish VIDEO "${String(d.title ?? "")}" to ${where} — watch it below before approving:`
        : `Publish social post to ${where}:`;
    }
    default:
      // Unknown action: still shown (never hidden), just raw. apply_proposal
      // will refuse it with a clear error if approved.
      return `${p.action}: ${JSON.stringify(d)}`;
  }
}

// The content agent's social.post payload extras (see services/godley-os-bot,
// src/lib/content-agent-acts.ts): the image, one caption per target
// venture, and the target list. Absent on a text post, which shows its
// text alone.
const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X/Twitter",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function socialTargets(payload: Record<string, unknown>): { slug: string; name: string; platforms: string[] }[] {
  if (!Array.isArray(payload.targets)) return [];
  return (payload.targets as unknown[]).flatMap((raw) => {
    const t = raw as Record<string, unknown>;
    if (typeof t.slug !== "string" || typeof t.name !== "string") return [];
    const platforms = Array.isArray(t.platforms) ? (t.platforms as unknown[]).filter((p): p is string => typeof p === "string") : [];
    return [{ slug: t.slug, name: t.name, platforms }];
  });
}

function socialCaptions(payload: Record<string, unknown>): [string, string][] {
  const captions = payload.captions;
  if (typeof captions !== "object" || captions === null || Array.isArray(captions)) return [];
  return Object.entries(captions as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
}

function firstMediaUrl(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.mediaUrls)) return null;
  const first = (payload.mediaUrls as unknown[]).find((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  return first ?? null;
}

function SocialPostPreview({ payload }: { payload: Record<string, unknown> }) {
  const mediaUrl = firstMediaUrl(payload);
  const targets = socialTargets(payload);
  const captions = socialCaptions(payload);
  const byTarget =
    targets.length > 0 && captions.length > 0
      ? targets.map((t) => ({ name: t.name, text: captions.find(([slug]) => slug === t.slug)?.[1] ?? String(payload.text ?? "") }))
      : [{ name: null, text: String(payload.text ?? "") }];
  return (
    <div className="approval-social">
      {mediaUrl && <img className="approval-image" src={mediaUrl} alt="post image" loading="lazy" />}
      {byTarget.map((c, i) => (
        <div key={i}>
          {c.name && <p className="muted approval-meta">{c.name}</p>}
          <p className="approval-payload prewrap">{c.text}</p>
        </div>
      ))}
      {typeof payload.credit === "string" && payload.credit && <p className="muted approval-meta">Credit: {payload.credit}</p>}
    </div>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ApprovalsCard({ ventureId }: { ventureId?: string }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [justApproved, setJustApproved] = useState<Proposal | null>(null);

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
      setError(explainDbError(error));
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
    // Realtime: a proposal filed from automation should appear while you're
    // looking at the screen. Best-effort — the visibilitychange refetch below
    // keeps the list honest every time the phone comes back to this app.
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
    setJustApproved(p);
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

  return (
    <section className="card approvals" id="approvals">
      <h3>
        Approvals{" "}
        {proposals.length > 0 && <span className="chip chip-paused">{proposals.length}</span>}
      </h3>
      {error && <p className="error-banner">{error}</p>}
      {justApproved && justApproved.ventures && (
        <p className="approved-note">
          Approved.{" "}
          {justApproved.action === "note.append" ? (
            <Link to={`/v/${justApproved.ventures.slug}`}>
              View in {justApproved.ventures.name} notes →
            </Link>
          ) : (
            <Link to={`/v/${justApproved.ventures.slug}`}>
              View {justApproved.ventures.name} →
            </Link>
          )}
        </p>
      )}
      {loaded && proposals.length === 0 && !error ? (
        <p className="muted">Nothing needs your approval.</p>
      ) : (
        <ul className="approval-list">
          {proposals.map((p) => (
            <li key={p.id} className="approval-item">
              <div className="approval-body">
                <p className="approval-desc">{summarize(p)}</p>
                {p.action === "social.post" && typeof p.payload.preview_url === "string" && (
                  <p className="approval-payload">
                    <a href={p.payload.preview_url} target="_blank" rel="noreferrer">
                      ▶ Watch the video
                    </a>
                  </p>
                )}
                {(p.action === "note.append" || p.action === "whatsapp.message") && (
                  <p className="approval-payload prewrap">{String(p.payload.text ?? "")}</p>
                )}
                {p.action === "social.post" && <SocialPostPreview payload={p.payload} />}
                {p.action === "video.script" && (
                  <p className="approval-payload prewrap">{String(p.payload.script ?? "")}</p>
                )}
                <p className="muted approval-meta">
                  {!ventureId && p.ventures ? `${p.ventures.name} · ` : ""}
                  {p.proposed_by} · {when(p.created_at)}
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
      )}
    </section>
  );
}
