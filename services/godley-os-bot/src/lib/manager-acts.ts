// ACT tool support for the AI Manager — the two halves of the confirmation
// gate that touch the database:
//
//  describeAct: at PROPOSAL time, validate the model's tool input against
//  reality and build the exact human-readable line the owner confirms. The
//  summary is code-built from database rows, never model text — what you
//  confirm is what runs.
//
//  executeActs: at CONFIRMATION time ("yes"), run each act through the SAME
//  code paths the Slack buttons and the admin route use — recordDecision /
//  apply_proposal for approve, the pending-guarded update for reject,
//  fileSocialDraft for drafts. No new approval logic. Stops on the first
//  failure; the rest are reported as not executed.

import { resolveBlotatoKey, ventureKeyName } from "../integrations/blotato.js";
import { describeSyncResult, syncBlotatoAccounts } from "./blotato-sync.js";
import { formatUtc } from "./brief-blocks.js";
import { DECIDER_NAME, disarmDecidedPrompt, recordDecision } from "./decisions.js";
import { fileSocialDraft } from "./file-social-draft.js";
import type { ActToolName, ProposedAct } from "./pending-actions.js";
import { getSupabase } from "./supabase.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActDescription = { ok: true; act: ProposedAct } | { ok: false; problem: string };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// One row of the real pending list, as resolvePendingReference needs it.
export interface PendingRef {
  id: string;
  venture: string;
  action: string;
}

// The model sometimes passes a made-up handle ("pending-lil-bull-note")
// instead of the uuid. Resolve it against the ACTUAL pending list rather
// than refusing: unambiguous (one pending proposal, or a unique uuid
// prefix) → that proposal; ambiguous or empty → a problem that names the
// real candidates. Safe because the resolved id still goes through the
// same status check below and the owner confirms a summary built from the
// resolved row — never from the model's text.
export function resolvePendingReference(ref: string, pending: PendingRef[]): { ok: true; id: string } | { ok: false; problem: string } {
  if (UUID_RE.test(ref)) return { ok: true, id: ref };
  const label = `"${ref || "(empty)"}" is not a proposal id`;
  if (pending.length === 0) {
    return { ok: false, problem: `${label} and no proposal is pending — there is nothing to decide` };
  }
  if (pending.length === 1) return { ok: true, id: pending[0]!.id };
  const prefix = ref.toLowerCase();
  const prefixMatches = prefix === "" ? [] : pending.filter((p) => p.id.toLowerCase().startsWith(prefix));
  if (prefixMatches.length === 1) return { ok: true, id: prefixMatches[0]!.id };
  const listing = pending.map((p) => `${p.id} (${p.venture} · ${p.action})`).join("; ");
  return { ok: false, problem: `${label} and ${pending.length} proposals are pending — say which one: ${listing}` };
}

// Fetches the pending list and maps the reference onto it (see
// resolvePendingReference). Only called for a non-uuid reference.
async function resolveAgainstPendingList(ref: string): Promise<{ ok: true; id: string } | { ok: false; problem: string }> {
  const { data, error } = await getSupabase()
    .from("proposals")
    .select("id, action, venture:ventures(name)")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(25);
  if (error) return { ok: false, problem: `could not load the pending list to resolve "${ref}": ${error.message}` };
  const pending: PendingRef[] = (data ?? []).map((raw) => {
    const d = raw as Record<string, unknown>;
    const ventureRaw = Array.isArray(d.venture) ? d.venture[0] : d.venture;
    const venture = (ventureRaw as { name?: unknown } | null)?.name;
    return {
      id: String(d.id),
      venture: typeof venture === "string" ? venture : "(unknown venture)",
      action: String(d.action),
    };
  });
  return resolvePendingReference(ref, pending);
}

async function describeDecision(tool: "approve_proposal" | "reject_proposal", input: Record<string, unknown>): Promise<ActDescription> {
  let id = typeof input.proposal_id === "string" ? input.proposal_id.trim() : "";
  if (!UUID_RE.test(id)) {
    const resolved = await resolveAgainstPendingList(id);
    if (!resolved.ok) return resolved;
    id = resolved.id;
  }
  const { data, error } = await getSupabase()
    .from("proposals")
    .select("id, status, action, proposed_by, created_at, venture:ventures(name)")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, problem: `could not load proposal ${id}: ${error.message}` };
  if (!data) return { ok: false, problem: `no proposal with id ${id}` };
  const d = data as Record<string, unknown>;
  const ventureRaw = Array.isArray(d.venture) ? d.venture[0] : d.venture;
  const venture = (ventureRaw as { name?: unknown } | null)?.name;
  const ventureLabel = typeof venture === "string" ? venture : "(unknown venture)";
  if (d.status !== "pending") {
    return {
      ok: false,
      problem: `the ${ventureLabel} ${String(d.action)} proposal ${id} was already ${String(d.status)} — nothing to decide`,
    };
  }
  const filed = typeof d.created_at === "string" ? formatUtc(new Date(d.created_at)) : "unknown time";
  const verb = tool === "approve_proposal" ? "Approve" : "Reject";
  return {
    ok: true,
    act: {
      tool,
      input: { proposal_id: id },
      summary: `${verb} — ${ventureLabel} · ${String(d.action)} from ${String(d.proposed_by)} (filed ${filed})`,
    },
  };
}

async function describeDraft(input: Record<string, unknown>): Promise<ActDescription> {
  const slug = typeof input.venture_slug === "string" ? input.venture_slug.trim() : "";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const platforms = Array.isArray(input.platforms)
    ? input.platforms.filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : [];
  if (!slug) return { ok: false, problem: "create_social_draft needs a venture_slug" };
  if (!text) return { ok: false, problem: "create_social_draft needs the post text" };
  if (platforms.length === 0) return { ok: false, problem: "create_social_draft needs at least one platform" };

  const { data, error } = await getSupabase()
    .from("ventures")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();
  if (error) return { ok: false, problem: `ventures lookup failed: ${error.message}` };
  if (!data) return { ok: false, problem: `no venture with slug "${slug}"` };
  const name = (data as { name?: unknown }).name;
  const ventureLabel = typeof name === "string" ? name : slug;

  return {
    ok: true,
    act: {
      tool: "create_social_draft",
      input: { venture_slug: slug, text, platforms },
      summary:
        `File a social draft — ${ventureLabel} → ${platforms.join(", ")}: ` +
        `"${truncate(text, 120)}" (it will still need approval before anything publishes)`,
    },
  };
}

// The account sync: internal configuration (venture_platforms rows) read
// from Blotato with the venture's OWN key. Confirmed like every other act
// because it changes where the venture's posts go.
async function describeSync(input: Record<string, unknown>): Promise<ActDescription> {
  const slug = typeof input.venture_slug === "string" ? input.venture_slug.trim() : "";
  if (!slug) return { ok: false, problem: "sync_blotato_accounts needs a venture_slug" };
  const { data, error } = await getSupabase().from("ventures").select("name").eq("slug", slug).maybeSingle();
  if (error) return { ok: false, problem: `ventures lookup failed: ${error.message}` };
  if (!data) return { ok: false, problem: `no venture with slug "${slug}"` };
  const name = (data as { name?: unknown }).name;
  const ventureLabel = typeof name === "string" ? name : slug;
  const keyName = ventureKeyName(slug);
  if (resolveBlotatoKey(slug).key === null) {
    return { ok: false, problem: `${keyName} is not in the environment yet (or is the "pending" placeholder) — paste ${ventureLabel}'s Blotato key into Doppler first, then ask again` };
  }
  return {
    ok: true,
    act: {
      tool: "sync_blotato_accounts",
      input: { venture_slug: slug },
      summary:
        `Sync Blotato accounts — ${ventureLabel}: read its connected Instagram + Facebook accounts (and the Facebook Page) with ${keyName} ` +
        "and write their ids into venture_platforms (publishes nothing)",
    },
  };
}

export async function describeAct(tool: ActToolName, input: Record<string, unknown>): Promise<ActDescription> {
  if (tool === "approve_proposal" || tool === "reject_proposal") return describeDecision(tool, input);
  if (tool === "sync_blotato_accounts") return describeSync(input);
  if (tool === "file_for_approval") {
    return { ok: false, problem: "file_for_approval belongs to the venture content agent — drop the image in the venture's channel instead" };
  }
  return describeDraft(input);
}

export interface ActOutcome {
  summary: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
}

const MANAGER_VIA = `by ${DECIDER_NAME} (manager)`;

async function executeOne(act: ProposedAct): Promise<string> {
  if (act.tool === "approve_proposal" || act.tool === "reject_proposal") {
    const proposalId = act.input.proposal_id as string;
    const decision = act.tool === "approve_proposal" ? "approve" : "reject";
    await recordDecision(decision, proposalId);
    // Same-tables sync: the app inbox sees the flip via the shared proposals
    // table; the Slack buttons message is retired here (PR #5 disarm logic).
    const disarm = await disarmDecidedPrompt(proposalId, MANAGER_VIA);
    return decision === "approve" ? `approved and applied; ${disarm}` : `rejected; ${disarm}`;
  }
  if (act.tool === "sync_blotato_accounts") {
    const result = await syncBlotatoAccounts(act.input.venture_slug as string);
    if (!result.ok) throw new Error(result.error);
    return `venture_platforms updated for ${result.venture.name}:\n${describeSyncResult(result)}`;
  }
  if (act.tool === "file_for_approval") {
    throw new Error("file_for_approval is the content agent's act and never runs from #studio-admin");
  }
  const result = await fileSocialDraft(act.input.venture_slug as string, {
    text: act.input.text,
    platforms: act.input.platforms,
  });
  if (!result.ok) throw new Error(result.error);
  return `filed as proposal ${result.proposalId} — it now needs approval like any other`;
}

// Stop on failure: the first error halts the batch and everything after it
// is reported as not executed — never a silent partial run.
export async function executeActs(acts: ProposedAct[]): Promise<ActOutcome[]> {
  const outcomes: ActOutcome[] = [];
  for (let i = 0; i < acts.length; i++) {
    const act = acts[i]!;
    try {
      const detail = await executeOne(act);
      outcomes.push({ summary: act.summary, ok: true, skipped: false, detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ summary: act.summary, ok: false, skipped: false, detail: message });
      for (const rest of acts.slice(i + 1)) {
        outcomes.push({
          summary: rest.summary,
          ok: false,
          skipped: true,
          detail: "not executed — stopped after the failure above",
        });
      }
      break;
    }
  }
  return outcomes;
}
