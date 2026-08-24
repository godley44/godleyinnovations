// The bot's background cycle (every 60s), three steps over the approvals
// pipeline, each tracked in its own ledger so restarts can never double-post:
//
//  A. DELIVERY — approved weekly-insight proposals → post the brief to the
//     venture's channel; tracked in slack_deliveries (migration 004).
//  B. PROMPTS  — PENDING proposals (any action) → post an Approval-needed
//     message with Approve/Reject buttons wired to the interactions route;
//     tracked in slack_prompts (migration 005).
//  C. DISARM   — slack_prompts rows still 'posted' whose proposal is no
//     longer pending (decided in the app inbox, or the interactions route
//     failed to re-render) → chat.update the message to the decided layout
//     and mark the row 'disarmed'. Buttons never stay live for a decided
//     proposal.
//
// Channel routing everywhere: the channel whose name equals ventures.slug
// (the venture-map.ts convention, applied venture→channel).
//
// The double-post protection in A and B is the order of operations, do not
// reorder: 1. CLAIM (insert status='posting' — unique(proposal_id) makes it
// atomic; a conflict means another run owns it), 2. POST, 3. RECORD. A crash
// between 1 and 3 leaves a 'posting' row that is surfaced as needing
// attention and never retried automatically — attention beats a duplicate in
// the channel. Failures (no channel named after the slug, bot not a member,
// empty payload) are terminal 'failed' rows with the reason: fix the cause,
// delete the row, the next cycle re-arms. No silent retries, no guessing
// alternate channels. The one deliberate exception is C's chat.update: it is
// a repair of an already-decided message, so a transient failure there is
// retried on later cycles (logged once), and a message that no longer exists
// is marked disarmed as-is.
//
// Step order matters for partial deploys: A runs before B/C, so a bot
// deployed ahead of the hand-run migration 005 keeps delivering briefs while
// the prompt steps fail loudly with "run migration 005".

import { buildApprovalPrompt, buildDecidedMessage } from "./approval-blocks.js";
import { buildBriefMessage } from "./brief-blocks.js";
import { getSupabase } from "./supabase.js";
import { listChannelsByName, postMessage, updateMessage, type SlackChannel } from "./slack-web.js";

const POLL_INTERVAL_MS = 60 * 1000;
const POLL_LIMIT = 10;
const DISARM_SCAN_LIMIT = 20;

export type DeliveryStatus =
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
  status: DeliveryStatus;
  channelId?: string;
  messageTs?: string;
  detail?: string;
}

export type PromptStatus =
  | "posted" // buttons went live this cycle
  | "already-posted" // buttons are live from an earlier cycle
  | "disarmed" // re-rendered this cycle (proposal decided elsewhere)
  | "already-disarmed"
  | "failed"
  | "previously-failed"
  | "posting-stuck";

export interface PromptCandidate {
  proposalId: string;
  ventureSlug: string;
  ventureName: string;
  action: string;
  proposedBy: string;
  createdAt: string;
  status: PromptStatus;
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
  lastPromptPostedAt: string | null;
  lastDeliveries: DeliveryCandidate[];
  lastPrompts: PromptCandidate[];
}

const state: PollerState = {
  intervalRunning: false,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastCheckOk: null,
  lastCheckError: null,
  lastDeliveredAt: null,
  lastPromptPostedAt: null,
  lastDeliveries: [],
  lastPrompts: [],
};

export function getPollerState(): PollerState {
  return { ...state, lastDeliveries: [...state.lastDeliveries], lastPrompts: [...state.lastPrompts] };
}

interface ProposalRow {
  id: string;
  created_at: string;
  decided_at: string | null;
  action: string;
  proposed_by: string;
  status: string;
  payload: unknown;
  venture: { name: string; slug: string } | null;
}

// Supabase rows and embeds arrive untyped; normalize defensively instead of
// casting blind.
function normalizeProposal(raw: unknown): ProposalRow | null {
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
    action: typeof row.action === "string" ? row.action : "unknown",
    proposed_by: typeof row.proposed_by === "string" ? row.proposed_by : "automation",
    status: typeof row.status === "string" ? row.status : "unknown",
    payload: row.payload,
    venture,
  };
}

// Log each standing condition once per key per process, not every 60s.
const loggedKeys = new Set<string>();

function logOnce(key: string, message: string, isError: boolean): void {
  const full = `${key}:${message}`;
  if (loggedKeys.has(full)) return;
  loggedKeys.add(full);
  if (isError) console.error(message);
  else console.log(message);
}

// The bot can deploy ahead of the hand-run migrations (same reality
// os-ingest handles); say exactly what to run instead of leaking a PostgREST
// error.
function tableErrorMessage(
  message: string,
  code: string | undefined,
  table: string,
  migrationFile: string,
): string {
  if (code === "PGRST205" || new RegExp(`${table}.*(does not exist|schema cache)`, "i").test(message)) {
    return `the ${table} table doesn't exist yet — run supabase/migrations/${migrationFile} in the Supabase SQL editor. Nothing was posted by this step.`;
  }
  return `${table} query failed: ${message}`;
}

const UNIQUE_VIOLATION = "23505";

interface TrackerRow {
  status: string;
  error: string | null;
  channel_id: string | null;
  message_ts: string | null;
}

async function loadTrackerRows(
  table: "slack_deliveries" | "slack_prompts",
  migrationFile: string,
  proposalIds: string[],
): Promise<Map<string, TrackerRow>> {
  const rows = new Map<string, TrackerRow>();
  if (proposalIds.length === 0) return rows;
  const { data, error } = await getSupabase()
    .from(table)
    .select("proposal_id, status, error, channel_id, message_ts")
    .in("proposal_id", proposalIds);
  if (error) throw new Error(tableErrorMessage(error.message, error.code, table, migrationFile));
  for (const raw of data ?? []) {
    const d = raw as Record<string, unknown>;
    if (typeof d.proposal_id === "string" && typeof d.status === "string") {
      rows.set(d.proposal_id, {
        status: d.status,
        error: typeof d.error === "string" ? d.error : null,
        channel_id: typeof d.channel_id === "string" ? d.channel_id : null,
        message_ts: typeof d.message_ts === "string" ? d.message_ts : null,
      });
    }
  }
  return rows;
}

// Record a terminal failure. A unique-constraint conflict means another run
// already wrote this proposal's row — fine, the ledger stays first-write-wins.
async function recordFailure(
  table: "slack_deliveries" | "slack_prompts",
  migrationFile: string,
  proposalId: string,
  channelId: string | null,
  reason: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from(table)
    .insert({ proposal_id: proposalId, status: "failed", channel_id: channelId, error: reason });
  if (error && error.code !== UNIQUE_VIOLATION) {
    throw new Error(tableErrorMessage(error.message, error.code, table, migrationFile));
  }
}

// Resolve a venture's channel per the name=slug convention; returns either
// the channel or the terminal failure reason.
function resolveChannel(
  channels: Map<string, SlackChannel>,
  slug: string,
): { channel: SlackChannel } | { failure: string; channelId: string | null } {
  const channel = channels.get(slug);
  if (!channel) {
    return {
      failure: `no public Slack channel named #${slug} (channel name must equal ventures.slug)`,
      channelId: null,
    };
  }
  if (!channel.isMember) {
    return { failure: `bot is not a member of #${slug} (${channel.id}) — invite it with /invite`, channelId: channel.id };
  }
  return { channel };
}

// --- Step A: deliver approved weekly-insight briefs ------------------------

async function runDeliveryStep(channels: () => Promise<Map<string, SlackChannel>>): Promise<DeliveryCandidate[]> {
  const { data, error } = await getSupabase()
    .from("proposals")
    .select("id, created_at, decided_at, action, proposed_by, status, payload, venture:ventures(name, slug)")
    .eq("action", "note.append")
    .eq("proposed_by", "weekly-insight")
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(POLL_LIMIT);
  if (error) throw new Error(`proposals query failed: ${error.message}`);

  const rows = (data ?? []).map(normalizeProposal).filter((r): r is ProposalRow => r !== null && r.venture !== null);
  const tracker = await loadTrackerRows("slack_deliveries", "004_slack_deliveries.sql", rows.map((r) => r.id));

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

    const existing = tracker.get(row.id);
    if (existing) {
      if (existing.status === "failed") {
        candidate.status = "previously-failed";
        candidate.detail = existing.error ?? "no reason recorded";
        logOnce(row.id, `[poller] delivery of ${row.id} (${venture.slug}) previously failed: ${candidate.detail}`, true);
      } else if (existing.status === "posting") {
        candidate.status = "posting-stuck";
        candidate.detail =
          "claimed but never finalized (bot likely died mid-post) — check #" +
          `${venture.slug} for the brief; delete the slack_deliveries row only if it is NOT there`;
        logOnce(row.id, `[poller] NEEDS ATTENTION: delivery of ${row.id} is ${candidate.detail}`, true);
      }
      candidates.push(candidate);
      continue;
    }

    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const briefText = payload.text;
    let failureReason: string | null = null;
    let channelId: string | null = null;
    if (typeof briefText !== "string" || !briefText.trim()) {
      failureReason = "payload.text is missing or empty — nothing to post";
    } else {
      const resolved = resolveChannel(await channels(), venture.slug);
      if ("failure" in resolved) {
        failureReason = resolved.failure;
        channelId = resolved.channelId;
      } else {
        channelId = resolved.channel.id;
      }
    }

    if (failureReason) {
      await recordFailure("slack_deliveries", "004_slack_deliveries.sql", row.id, channelId, failureReason);
      candidate.status = "failed";
      candidate.detail = failureReason;
      if (channelId) candidate.channelId = channelId;
      logOnce(row.id, `[poller] DELIVERY FAILED: ${row.id} (${venture.slug}): ${failureReason}`, true);
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
        console.error(`[poller] delivery claim conflict on ${row.id} (${venture.slug}) — skipped`);
        candidates.push(candidate);
        continue;
      }
      throw new Error(tableErrorMessage(claimError.message, claimError.code, "slack_deliveries", "004_slack_deliveries.sql"));
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
      console.error(`[poller] DELIVERY FAILED: ${row.id} (${venture.slug}): ${reason}`);
      const { error: failError } = await getSupabase()
        .from("slack_deliveries")
        .update({ status: "failed", error: reason })
        .eq("proposal_id", row.id);
      if (failError) {
        // Row stays 'posting' — safe (never re-posted), but say so loudly.
        console.error(
          `[poller] CRITICAL: could not record the delivery failure for ${row.id} (${failError.message}); ` +
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
  return candidates;
}

// --- Step B: post Approve/Reject prompts for pending proposals -------------

async function runPromptStep(channels: () => Promise<Map<string, SlackChannel>>): Promise<PromptCandidate[]> {
  const { data, error } = await getSupabase()
    .from("proposals")
    .select("id, created_at, decided_at, action, proposed_by, status, payload, venture:ventures(name, slug)")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(POLL_LIMIT);
  if (error) throw new Error(`proposals query failed: ${error.message}`);

  const rows = (data ?? []).map(normalizeProposal).filter((r): r is ProposalRow => r !== null && r.venture !== null);
  const tracker = await loadTrackerRows("slack_prompts", "005_slack_prompts.sql", rows.map((r) => r.id));

  const candidates: PromptCandidate[] = [];
  for (const row of rows) {
    const venture = row.venture!;
    const candidate: PromptCandidate = {
      proposalId: row.id,
      ventureSlug: venture.slug,
      ventureName: venture.name,
      action: row.action,
      proposedBy: row.proposed_by,
      createdAt: row.created_at,
      status: "already-posted",
    };

    const existing = tracker.get(row.id);
    if (existing) {
      if (existing.status === "failed") {
        candidate.status = "previously-failed";
        candidate.detail = existing.error ?? "no reason recorded";
        logOnce(row.id, `[poller] prompt for ${row.id} (${venture.slug}) previously failed: ${candidate.detail}`, true);
      } else if (existing.status === "posting") {
        candidate.status = "posting-stuck";
        candidate.detail =
          "claimed but never finalized (bot likely died mid-post) — check #" +
          `${venture.slug} for the buttons message; delete the slack_prompts row only if it is NOT there`;
        logOnce(row.id, `[poller] NEEDS ATTENTION: prompt for ${row.id} is ${candidate.detail}`, true);
      } else if (existing.status === "disarmed") {
        // Pending again with a disarmed prompt should be impossible
        // (decisions are final); surface rather than re-post.
        candidate.status = "already-disarmed";
        candidate.detail = "prompt already disarmed but proposal is pending — inspect by hand";
        logOnce(row.id, `[poller] NEEDS ATTENTION: ${candidate.detail} (${row.id})`, true);
      } else if (existing.message_ts) {
        candidate.messageTs = existing.message_ts;
      }
      candidates.push(candidate);
      continue;
    }

    const resolved = resolveChannel(await channels(), venture.slug);
    if ("failure" in resolved) {
      await recordFailure("slack_prompts", "005_slack_prompts.sql", row.id, resolved.channelId, resolved.failure);
      candidate.status = "failed";
      candidate.detail = resolved.failure;
      if (resolved.channelId) candidate.channelId = resolved.channelId;
      logOnce(row.id, `[poller] PROMPT FAILED: ${row.id} (${venture.slug}): ${resolved.failure}`, true);
      candidates.push(candidate);
      continue;
    }
    const channelId = resolved.channel.id;

    // CLAIM before posting — same protocol as delivery.
    const { error: claimError } = await getSupabase()
      .from("slack_prompts")
      .insert({ proposal_id: row.id, status: "posting", channel_id: channelId });
    if (claimError) {
      if (claimError.code === UNIQUE_VIOLATION) {
        candidate.status = "posting-stuck";
        candidate.detail = "another writer claimed this prompt between read and claim — not posting";
        console.error(`[poller] prompt claim conflict on ${row.id} (${venture.slug}) — skipped`);
        candidates.push(candidate);
        continue;
      }
      throw new Error(tableErrorMessage(claimError.message, claimError.code, "slack_prompts", "005_slack_prompts.sql"));
    }

    candidate.channelId = channelId;
    const message = buildApprovalPrompt({
      proposalId: row.id,
      ventureName: venture.name,
      action: row.action,
      proposedBy: row.proposed_by,
      createdAt: new Date(row.created_at),
      payload: (row.payload ?? {}) as Record<string, unknown>,
    });

    let messageTs: string;
    try {
      messageTs = await postMessage({ channel: channelId, text: message.text, blocks: message.blocks });
    } catch (postErr) {
      const reason = `chat.postMessage failed: ${postErr instanceof Error ? postErr.message : String(postErr)}`;
      candidate.status = "failed";
      candidate.detail = reason;
      console.error(`[poller] PROMPT FAILED: ${row.id} (${venture.slug}): ${reason}`);
      const { error: failError } = await getSupabase()
        .from("slack_prompts")
        .update({ status: "failed", error: reason })
        .eq("proposal_id", row.id);
      if (failError) {
        console.error(
          `[poller] CRITICAL: could not record the prompt failure for ${row.id} (${failError.message}); ` +
            "its slack_prompts row remains 'posting'",
        );
      }
      candidates.push(candidate);
      continue;
    }

    const { error: recordError } = await getSupabase()
      .from("slack_prompts")
      .update({ status: "posted", message_ts: messageTs })
      .eq("proposal_id", row.id);
    candidate.status = "posted";
    candidate.messageTs = messageTs;
    state.lastPromptPostedAt = new Date().toISOString();
    if (recordError) {
      candidate.detail =
        `POSTED buttons to #${venture.slug} (ts ${messageTs}) but recording 'posted' failed: ${recordError.message}. ` +
        "The row remains 'posting' — do NOT delete it.";
      console.error(`[poller] CRITICAL: ${candidate.detail}`);
    } else {
      console.log(`[poller] posted approval prompt for ${row.id} (${venture.slug}) to ${channelId} (ts ${messageTs})`);
    }
    candidates.push(candidate);
  }
  return candidates;
}

// --- Step C: disarm prompts whose proposal was decided elsewhere -----------

async function runDisarmStep(): Promise<PromptCandidate[]> {
  const { data, error } = await getSupabase()
    .from("slack_prompts")
    .select("proposal_id, channel_id, message_ts")
    .eq("status", "posted")
    .limit(DISARM_SCAN_LIMIT);
  if (error) throw new Error(tableErrorMessage(error.message, error.code, "slack_prompts", "005_slack_prompts.sql"));

  const prompts = (data ?? [])
    .map((raw) => raw as Record<string, unknown>)
    .filter(
      (d): d is { proposal_id: string; channel_id: string; message_ts: string } =>
        typeof d.proposal_id === "string" && typeof d.channel_id === "string" && typeof d.message_ts === "string",
    );
  if (prompts.length === 0) return [];

  const { data: pData, error: pError } = await getSupabase()
    .from("proposals")
    .select("id, created_at, decided_at, action, proposed_by, status, payload, venture:ventures(name, slug)")
    .in(
      "id",
      prompts.map((p) => p.proposal_id),
    );
  if (pError) throw new Error(`proposals query failed: ${pError.message}`);
  const proposals = new Map(
    (pData ?? [])
      .map(normalizeProposal)
      .filter((r): r is ProposalRow => r !== null && r.venture !== null)
      .map((r) => [r.id, r]),
  );

  const candidates: PromptCandidate[] = [];
  for (const prompt of prompts) {
    const proposal = proposals.get(prompt.proposal_id);
    if (!proposal || proposal.status === "pending") continue; // still live — nothing to do

    const venture = proposal.venture!;
    const candidate: PromptCandidate = {
      proposalId: proposal.id,
      ventureSlug: venture.slug,
      ventureName: venture.name,
      action: proposal.action,
      proposedBy: proposal.proposed_by,
      createdAt: proposal.created_at,
      status: "disarmed",
      channelId: prompt.channel_id,
      messageTs: prompt.message_ts,
    };

    const decided = buildDecidedMessage({
      decision: proposal.status === "approved" ? "approve" : "reject",
      ventureName: venture.name,
      action: proposal.action,
      proposedBy: proposal.proposed_by,
      decidedAt: proposal.decided_at ? new Date(proposal.decided_at) : new Date(),
    });
    try {
      await updateMessage({
        channel: prompt.channel_id,
        ts: prompt.message_ts,
        text: decided.text,
        blocks: decided.blocks,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/message_not_found/.test(message)) {
        // Transient — leave 'posted' so a later cycle repairs it, but say so.
        candidate.detail = `chat.update failed (${message}) — will retry next cycle`;
        logOnce(proposal.id, `[poller] disarm of ${proposal.id} failed: ${message}`, true);
        candidates.push(candidate);
        continue;
      }
      // The message is gone (deleted by hand): nothing left to disarm.
      candidate.detail = "original message no longer exists — marked disarmed";
    }

    const { error: markError } = await getSupabase()
      .from("slack_prompts")
      .update({ status: "disarmed", disarmed_at: new Date().toISOString() })
      .eq("proposal_id", proposal.id)
      .eq("status", "posted");
    if (markError) {
      candidate.detail = `message disarmed but recording it failed: ${markError.message} — will retry next cycle`;
      console.error(`[poller] ${candidate.detail} (${proposal.id})`);
    } else {
      console.log(`[poller] disarmed prompt for ${proposal.id} (${venture.slug}) — decided as ${proposal.status}`);
    }
    candidates.push(candidate);
  }
  return candidates;
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
    // Slack's channel roster is fetched at most once per cycle, and only if
    // some step actually needs it.
    let channelsPromise: Promise<Map<string, SlackChannel>> | null = null;
    const channels = () => (channelsPromise ??= listChannelsByName());

    state.lastDeliveries = await runDeliveryStep(channels);
    state.lastPrompts = [...(await runPromptStep(channels)), ...(await runDisarmStep())];

    state.lastCheckAt = startedAt;
    state.lastSuccessAt = startedAt;
    state.lastCheckOk = true;
    state.lastCheckError = null;
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
  console.log(`[poller] started (every ${POLL_INTERVAL_MS / 1000}s: deliveries, approval prompts, disarm)`);
  const tick = () => {
    runPollCycle().catch((err) => {
      console.error("[poller] tick failed unexpectedly:", err);
    });
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
