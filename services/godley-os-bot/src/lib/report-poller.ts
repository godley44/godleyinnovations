// Report delivery poller: posts approved OS reports to Slack, tracked in
// the slack_deliveries ledger (migration 004).
//
// What a cycle does: find reports that are ready for Slack — proposals with
// action='note.append', proposed_by='weekly-insight', status='approved'
// (approved is the gate on purpose: the brief reaches a channel only after
// the owner signed it, same as every other automated write) — skip the ones
// slack_deliveries already accounts for, and deliver the rest to the channel
// whose name equals ventures.slug (the venture-map.ts convention, applied in
// the venture→channel direction).
//
// The double-post protection is the order of operations, do not reorder:
//   1. CLAIM   insert slack_deliveries (proposal_id, status='posting') —
//              unique(proposal_id) makes this atomic; a conflict means some
//              other run owns the report, so this one never posts it.
//   2. POST    chat.postMessage.
//   3. RECORD  update the row to 'delivered' + message_ts.
// A crash between 1 and 3 leaves a 'posting' row: that report is surfaced as
// needing attention and never retried automatically — attention beats a
// duplicate in the channel. Failures (no channel named after the slug, bot
// not a member, empty payload) are recorded as 'failed' with the reason and
// are terminal: fix the cause, delete the row, and the next cycle re-arms.
// No silent retries, no guessing alternate channels.

import { buildBriefMessage } from "./brief-blocks.js";
import { getSupabase } from "./supabase.js";
import { listChannelsByName, postMessage } from "./slack-web.js";

const POLL_INTERVAL_MS = 60 * 1000;
const POLL_LIMIT = 10;

export type CandidateStatus =
  | "delivered" // posted this cycle
  | "already-delivered"
  | "failed" // recorded as failed this cycle (reason in detail)
  | "previously-failed"
  | "posting-stuck"; // claimed but never finalized — needs the owner's eyes

export interface DeliveryCandidate {
  proposalId: string;
  ventureSlug: string;
  ventureName: string;
  generatedAt: string;
  approvedAt: string | null;
  status: CandidateStatus;
  channelId?: string;
  messageTs?: string;
  detail?: string;
}

export interface PollerState {
  intervalRunning: boolean;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  lastDeliveredAt: string | null;
  lastCandidates: DeliveryCandidate[];
}

const state: PollerState = {
  intervalRunning: false,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastCheckOk: null,
  lastCheckError: null,
  lastDeliveredAt: null,
  lastCandidates: [],
};

export function getPollerState(): PollerState {
  return { ...state, lastCandidates: [...state.lastCandidates] };
}

interface ProposalRow {
  id: string;
  created_at: string;
  decided_at: string | null;
  payload: unknown;
  venture: { name: string; slug: string } | null;
}

// Supabase embeds arrive untyped; normalize defensively instead of casting
// blind.
function normalizeRow(raw: unknown): ProposalRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.created_at !== "string") return null;
  const ventureRaw = Array.isArray(row.venture) ? row.venture[0] : row.venture;
  let venture: ProposalRow["venture"] = null;
  if (typeof ventureRaw === "object" && ventureRaw !== null) {
    const v = ventureRaw as Record<string, unknown>;
    if (typeof v.name === "string" && typeof v.slug === "string") {
      venture = { name: v.name, slug: v.slug };
    }
  }
  return {
    id: row.id,
    created_at: row.created_at,
    decided_at: typeof row.decided_at === "string" ? row.decided_at : null,
    payload: row.payload,
    venture,
  };
}

// Log each standing condition once per proposal per process, not every 60s.
const loggedProposals = new Set<string>();

function logOnce(proposalId: string, message: string, isError: boolean): void {
  const key = `${proposalId}:${message}`;
  if (loggedProposals.has(key)) return;
  loggedProposals.add(key);
  if (isError) console.error(message);
  else console.log(message);
}

// The bot can deploy ahead of the hand-run migration (same reality os-ingest
// handles); say exactly what to do instead of leaking a PostgREST error.
function deliveriesErrorMessage(message: string, code: string | undefined): string {
  if (code === "PGRST205" || /slack_deliveries.*(does not exist|schema cache)/i.test(message)) {
    return (
      "the slack_deliveries table doesn't exist yet — run " +
      "supabase/migrations/004_slack_deliveries.sql in the Supabase SQL editor. " +
      "No reports were posted."
    );
  }
  return `slack_deliveries query failed: ${message}`;
}

interface DeliveryRow {
  status: string;
  error: string | null;
}

const UNIQUE_VIOLATION = "23505";

// Record a terminal failure. A unique-constraint conflict means another run
// already wrote this report's row — fine, the ledger stays first-write-wins.
async function recordFailure(proposalId: string, channelId: string | null, reason: string): Promise<void> {
  const { error } = await getSupabase()
    .from("slack_deliveries")
    .insert({ proposal_id: proposalId, status: "failed", channel_id: channelId, error: reason });
  if (error && error.code !== UNIQUE_VIOLATION) {
    throw new Error(deliveriesErrorMessage(error.message, error.code));
  }
}

export interface CycleResult {
  skipped: boolean;
  state: PollerState;
}

let cycleInFlight = false;

export async function runPollCycle(): Promise<CycleResult> {
  if (cycleInFlight) return { skipped: true, state: getPollerState() };
  cycleInFlight = true;
  const startedAt = new Date().toISOString();
  try {
    const { data, error } = await getSupabase()
      .from("proposals")
      .select("id, created_at, decided_at, payload, venture:ventures(name, slug)")
      .eq("action", "note.append")
      .eq("proposed_by", "weekly-insight")
      .eq("status", "approved")
      .order("decided_at", { ascending: false })
      .limit(POLL_LIMIT);
    if (error) throw new Error(`proposals query failed: ${error.message}`);

    const rows = (data ?? []).map(normalizeRow).filter((r): r is ProposalRow => r !== null && r.venture !== null);

    const deliveries = new Map<string, DeliveryRow>();
    if (rows.length > 0) {
      const { data: dData, error: dError } = await getSupabase()
        .from("slack_deliveries")
        .select("proposal_id, status, error")
        .in(
          "proposal_id",
          rows.map((r) => r.id),
        );
      if (dError) throw new Error(deliveriesErrorMessage(dError.message, dError.code));
      for (const raw of dData ?? []) {
        const d = raw as { proposal_id?: unknown; status?: unknown; error?: unknown };
        if (typeof d.proposal_id === "string" && typeof d.status === "string") {
          deliveries.set(d.proposal_id, { status: d.status, error: typeof d.error === "string" ? d.error : null });
        }
      }
    }

    const undelivered = rows.filter((r) => !deliveries.has(r.id));
    // Slack is only consulted when there is something to deliver.
    const channels = undelivered.length > 0 ? await listChannelsByName() : null;

    const candidates: DeliveryCandidate[] = [];
    for (const row of rows) {
      const venture = row.venture!;
      const candidate: DeliveryCandidate = {
        proposalId: row.id,
        ventureSlug: venture.slug,
        ventureName: venture.name,
        generatedAt: row.created_at,
        approvedAt: row.decided_at,
        status: "already-delivered",
      };

      const existing = deliveries.get(row.id);
      if (existing) {
        if (existing.status === "failed") {
          candidate.status = "previously-failed";
          candidate.detail = existing.error ?? "no reason recorded";
          logOnce(row.id, `[poller] report ${row.id} (${venture.slug}) previously failed: ${candidate.detail}`, true);
        } else if (existing.status === "posting") {
          candidate.status = "posting-stuck";
          candidate.detail =
            "claimed but never finalized (bot likely died mid-post) — check #" +
            `${venture.slug} for the message; delete the slack_deliveries row only if it is NOT there`;
          logOnce(row.id, `[poller] NEEDS ATTENTION: report ${row.id} (${venture.slug}) is ${candidate.detail}`, true);
        }
        candidates.push(candidate);
        continue;
      }

      // Undelivered — decide, claim, post, record.
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const briefText = payload.text;
      let failureReason: string | null = null;
      let channelId: string | null = null;

      if (typeof briefText !== "string" || !briefText.trim()) {
        failureReason = "payload.text is missing or empty — nothing to post";
      } else {
        const channel = channels?.get(venture.slug);
        if (!channel) {
          failureReason = `no public Slack channel named #${venture.slug} (channel name must equal ventures.slug)`;
        } else if (!channel.isMember) {
          channelId = channel.id;
          failureReason = `bot is not a member of #${venture.slug} (${channel.id}) — invite it with /invite`;
        } else {
          channelId = channel.id;
        }
      }

      if (failureReason) {
        await recordFailure(row.id, channelId, failureReason);
        candidate.status = "failed";
        candidate.detail = failureReason;
        if (channelId) candidate.channelId = channelId;
        logOnce(row.id, `[poller] DELIVERY FAILED: report ${row.id} (${venture.slug}): ${failureReason}`, true);
        candidates.push(candidate);
        continue;
      }

      // CLAIM before posting — see the header comment; do not reorder.
      const { error: claimError } = await getSupabase()
        .from("slack_deliveries")
        .insert({ proposal_id: row.id, status: "posting", channel_id: channelId });
      if (claimError) {
        if (claimError.code === UNIQUE_VIOLATION) {
          candidate.status = "posting-stuck";
          candidate.detail = "another writer claimed this report between read and claim — not posting";
          console.error(`[poller] claim conflict on report ${row.id} (${venture.slug}) — skipped`);
          candidates.push(candidate);
          continue;
        }
        throw new Error(deliveriesErrorMessage(claimError.message, claimError.code));
      }

      candidate.channelId = channelId!;
      const message = buildBriefMessage({
        briefText: briefText as string,
        ventureName: venture.name,
        generatedAt: new Date(row.created_at),
      });

      let messageTs: string;
      try {
        messageTs = await postMessage({ channel: channelId!, text: message.text, blocks: message.blocks });
      } catch (postErr) {
        const reason = `chat.postMessage failed: ${postErr instanceof Error ? postErr.message : String(postErr)}`;
        candidate.status = "failed";
        candidate.detail = reason;
        console.error(`[poller] DELIVERY FAILED: report ${row.id} (${venture.slug}): ${reason}`);
        const { error: failError } = await getSupabase()
          .from("slack_deliveries")
          .update({ status: "failed", error: reason })
          .eq("proposal_id", row.id);
        if (failError) {
          // Row stays 'posting' — safe (never re-posted), but say so loudly.
          console.error(
            `[poller] CRITICAL: could not record the failure for ${row.id} (${failError.message}); ` +
              "its slack_deliveries row remains 'posting'",
          );
        }
        candidates.push(candidate);
        continue;
      }

      const { error: recordError } = await getSupabase()
        .from("slack_deliveries")
        .update({ status: "delivered", message_ts: messageTs })
        .eq("proposal_id", row.id);
      candidate.status = "delivered";
      candidate.messageTs = messageTs;
      state.lastDeliveredAt = new Date().toISOString();
      if (recordError) {
        // Posted for real but the ledger still says 'posting'. Deleting that
        // row would cause a duplicate post — surface it instead.
        candidate.detail =
          `POSTED to #${venture.slug} (ts ${messageTs}) but recording 'delivered' failed: ${recordError.message}. ` +
          "The row remains 'posting' — do NOT delete it.";
        console.error(`[poller] CRITICAL: ${candidate.detail}`);
      } else {
        console.log(`[poller] delivered report ${row.id} (${venture.slug}) to ${channelId} (ts ${messageTs})`);
      }
      candidates.push(candidate);
    }

    state.lastCheckAt = startedAt;
    state.lastSuccessAt = startedAt;
    state.lastCheckOk = true;
    state.lastCheckError = null;
    state.lastCandidates = candidates;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastCheckAt = startedAt;
    state.lastCheckOk = false;
    state.lastCheckError = message;
    console.error(`[poller] poll cycle failed: ${message}`);
  } finally {
    cycleInFlight = false;
  }
  return { skipped: false, state: getPollerState() };
}

export function startReportPoller(): void {
  if (state.intervalRunning) return;
  state.intervalRunning = true;
  console.log(`[poller] started (every ${POLL_INTERVAL_MS / 1000}s, delivery live)`);
  const tick = () => {
    runPollCycle().catch((err) => {
      console.error("[poller] tick failed unexpectedly:", err);
    });
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
