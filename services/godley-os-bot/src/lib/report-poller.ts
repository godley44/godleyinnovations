// The bot's background cycle (every 60s), six steps over the approvals
// pipeline, each tracked in its own ledger so restarts can never double-run:
//
//  A. DELIVERY — approved weekly-insight briefs AND approved
//     whatsapp.message proposals → posted to the venture's channel (brief
//     layout / WhatsApp hand-off layout); tracked in slack_deliveries
//     (migration 004).
//  B. FRAMING  — each approved weekly-insight brief is reframed ONCE by the
//     OpenAI framing agent and filed as a new pending whatsapp.message
//     proposal (proposed_by 'framing-agent'); tracked in framing_jobs
//     (migration 006). The new proposal then rides the normal rails below —
//     framing runs before the prompts step so its buttons post in the same
//     cycle. Nothing ever auto-sends to WhatsApp; the last hop is a manual
//     paste.
//  C. PROMPTS  — PENDING proposals (any action) → post an Approval-needed
//     message with Approve/Reject buttons wired to the interactions route;
//     tracked in slack_prompts (migration 005).
//  D. DISARM   — slack_prompts rows still 'posted' whose proposal is no
//     longer pending (decided in the app inbox, or the interactions route
//     failed to re-render) → chat.update the message to the decided layout
//     and mark the row 'disarmed'. Buttons never stay live for a decided
//     proposal.
//  E. PUBLISH  — content_calendar rows whose social.post proposal was
//     APPROVED → published per platform via Blotato (or dry-run logged while
//     the key is the placeholder); claim-before-publish per (post, platform)
//     in social_publishes (migration 007), one platform failing never blocks
//     the others, venture channel gets a per-platform summary. Also sweeps
//     'proposed' calendar rows whose proposal was REJECTED to 'rejected'
//     (rejection never runs apply_proposal, so the bot owns that flip). The
//     approval gate is the ONLY path here — scheduled_for is ignored.
//  F. CONFIRM  — Blotato publishing is async, so 'submitted' ledger rows are
//     polled (GET /v2/posts/:id) until 'published' (+public URL) or terminal
//     'failed'; the post's aggregate status and a final summary follow.
//
// Steps are isolated: each runs in its own try/catch and a failure in one
// (say, a migration not yet run by hand) never blocks the others — the
// cycle reports every step error, loudly, instead of dying on the first.
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

import { buildPublishRequest, getPostStatus, isDryRun, publishPost } from "../integrations/blotato.js";
import { frameForWhatsApp } from "../integrations/openai.js";
import { buildApprovalPrompt, buildDecidedMessage } from "./approval-blocks.js";
import { buildBriefMessage } from "./brief-blocks.js";
import { buildPublishSummary } from "./social-blocks.js";
import { aggregateCalendar, outcomeFromRow, type PublishLedgerRow, type PublishLedgerStatus } from "./social-publish.js";
import { getSupabase } from "./supabase.js";
import { listChannelsByName, postMessage, updateMessage, type SlackChannel } from "./slack-web.js";
import { buildWhatsAppDelivery } from "./whatsapp-blocks.js";

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

export type FramingStatus =
  | "framed" // framed and filed as a pending proposal this cycle
  | "already-framed"
  | "failed" // recorded as failed this cycle (reason in detail)
  | "previously-failed"
  | "framing-stuck"; // claimed but never finalized — needs the owner's eyes

export interface FramingCandidate {
  sourceProposalId: string;
  ventureSlug: string;
  ventureName: string;
  status: FramingStatus;
  framedProposalId?: string;
  detail?: string;
}

export type PublishStatus =
  | "published" // confirmed live by the status poll this cycle
  | "submitted" // accepted by Blotato this cycle, confirmation pending
  | "dry-run" // dry run recorded this cycle (no real key)
  | "failed" // recorded as failed this cycle (reason in detail)
  | "previously-failed"
  | "awaiting-confirmation" // submitted earlier; Blotato hasn't finished yet
  | "pending-real-key" // dry-run row from an earlier cycle — delete it to re-arm once the real key exists
  | "publishing-stuck"; // claimed but never finalized — needs the owner's eyes

export interface PublishCandidate {
  calendarId: string;
  platform: string;
  ventureSlug: string;
  ventureName: string;
  status: PublishStatus;
  submissionId?: string;
  publicUrl?: string;
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
  lastFramedAt: string | null;
  lastPublishActivityAt: string | null;
  lastDeliveries: DeliveryCandidate[];
  lastPrompts: PromptCandidate[];
  lastFramings: FramingCandidate[];
  lastPublishes: PublishCandidate[];
}

const state: PollerState = {
  intervalRunning: false,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastCheckOk: null,
  lastCheckError: null,
  lastDeliveredAt: null,
  lastPromptPostedAt: null,
  lastFramedAt: null,
  lastPublishActivityAt: null,
  lastDeliveries: [],
  lastPrompts: [],
  lastFramings: [],
  lastPublishes: [],
};

export function getPollerState(): PollerState {
  return {
    ...state,
    lastDeliveries: [...state.lastDeliveries],
    lastPrompts: [...state.lastPrompts],
    lastFramings: [...state.lastFramings],
    lastPublishes: [...state.lastPublishes],
  };
}

interface ProposalRow {
  id: string;
  created_at: string;
  decided_at: string | null;
  action: string;
  proposed_by: string;
  status: string;
  payload: unknown;
  venture_id: string | null;
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
    venture_id: typeof row.venture_id === "string" ? row.venture_id : null,
    venture,
  };
}

// The exact proposals row the framing step files — exported for the payload
// shape test. The venture is decided by the SOURCE proposal, never by the
// model; source_proposal_id in the payload ties the framed message back to
// the brief it came from.
export function framedProposalRow(
  source: { id: string; venture_id: string },
  framedText: string,
): {
  venture_id: string;
  action: "whatsapp.message";
  proposed_by: "framing-agent";
  payload: { text: string; source_proposal_id: string };
} {
  return {
    venture_id: source.venture_id,
    action: "whatsapp.message",
    proposed_by: "framing-agent",
    payload: { text: framedText, source_proposal_id: source.id },
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
// error. Exported for the admin routes, which hit the same tables.
export function tableErrorMessage(
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

const PROPOSAL_COLS =
  "id, created_at, decided_at, action, proposed_by, status, payload, venture_id, venture:ventures(name, slug)";

// Approved proposals the bot acts on: weekly-insight briefs (delivered as
// the brief layout AND framed for WhatsApp) and framed whatsapp.message
// proposals (delivered as the hand-off layout).
async function fetchApprovedWork(): Promise<{ briefs: ProposalRow[]; whatsapp: ProposalRow[] }> {
  const supabase = getSupabase();
  const briefsQuery = supabase
    .from("proposals")
    .select(PROPOSAL_COLS)
    .eq("action", "note.append")
    .eq("proposed_by", "weekly-insight")
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(POLL_LIMIT);
  const whatsappQuery = supabase
    .from("proposals")
    .select(PROPOSAL_COLS)
    .eq("action", "whatsapp.message")
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(POLL_LIMIT);
  const [briefsRes, whatsappRes] = [await briefsQuery, await whatsappQuery];
  if (briefsRes.error) throw new Error(`proposals query failed: ${briefsRes.error.message}`);
  // A database without migration 006 has no whatsapp.message rows, and this
  // filter query still succeeds against it (the CHECK constraint is not
  // consulted on reads) — so only a real error is thrown here.
  if (whatsappRes.error) throw new Error(`proposals query failed: ${whatsappRes.error.message}`);
  const normalize = (data: unknown[] | null) =>
    (data ?? []).map(normalizeProposal).filter((r): r is ProposalRow => r !== null && r.venture !== null);
  return { briefs: normalize(briefsRes.data), whatsapp: normalize(whatsappRes.data) };
}

// --- Step A: deliver approved briefs + approved WhatsApp hand-offs ---------

async function runDeliveryStep(
  briefs: ProposalRow[],
  whatsapp: ProposalRow[],
  channels: () => Promise<Map<string, SlackChannel>>,
): Promise<DeliveryCandidate[]> {
  const rows = [...briefs, ...whatsapp];
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
    const message =
      row.action === "whatsapp.message"
        ? buildWhatsAppDelivery({
            framedText: briefText as string,
            ventureName: venture.name,
            generatedAt: new Date(row.created_at),
          })
        : buildBriefMessage({
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

// --- Step B: frame approved briefs for WhatsApp ----------------------------

async function runFramingStep(briefs: ProposalRow[]): Promise<FramingCandidate[]> {
  const tracker = new Map<string, TrackerRow>();
  if (briefs.length > 0) {
    const { data, error } = await getSupabase()
      .from("framing_jobs")
      .select("source_proposal_id, status, error")
      .in(
        "source_proposal_id",
        briefs.map((r) => r.id),
      );
    if (error) throw new Error(tableErrorMessage(error.message, error.code, "framing_jobs", "006_whatsapp_framing.sql"));
    for (const raw of data ?? []) {
      const d = raw as Record<string, unknown>;
      if (typeof d.source_proposal_id === "string" && typeof d.status === "string") {
        tracker.set(d.source_proposal_id, {
          status: d.status,
          error: typeof d.error === "string" ? d.error : null,
          channel_id: null,
          message_ts: null,
        });
      }
    }
  }

  const candidates: FramingCandidate[] = [];
  for (const row of briefs) {
    const venture = row.venture!;
    const candidate: FramingCandidate = {
      sourceProposalId: row.id,
      ventureSlug: venture.slug,
      ventureName: venture.name,
      status: "already-framed",
    };

    const existing = tracker.get(row.id);
    if (existing) {
      if (existing.status === "failed") {
        candidate.status = "previously-failed";
        candidate.detail = existing.error ?? "no reason recorded";
        logOnce(row.id, `[poller] framing of ${row.id} (${venture.slug}) previously failed: ${candidate.detail}`, true);
      } else if (existing.status === "running") {
        candidate.status = "framing-stuck";
        candidate.detail =
          "claimed but never finalized (bot likely died mid-call) — check whether a framed proposal " +
          "exists for this brief; delete the framing_jobs row only if it does NOT";
        logOnce(row.id, `[poller] NEEDS ATTENTION: framing of ${row.id} is ${candidate.detail}`, true);
      }
      candidates.push(candidate);
      continue;
    }

    // Fail fast on unusable sources before claiming.
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const briefText = payload.text;
    const sourceProblem =
      typeof briefText !== "string" || !briefText.trim()
        ? "source payload.text is missing or empty — nothing to frame"
        : row.venture_id === null
          ? "source proposal has no venture_id — cannot file the framed proposal"
          : null;

    // CLAIM before calling OpenAI — same protocol as posting; a conflict
    // means another run owns this brief.
    const { error: claimError } = await getSupabase()
      .from("framing_jobs")
      .insert({ source_proposal_id: row.id, status: "running" });
    if (claimError) {
      if (claimError.code === UNIQUE_VIOLATION) {
        candidate.status = "framing-stuck";
        candidate.detail = "another writer claimed this framing between read and claim — not framing";
        console.error(`[poller] framing claim conflict on ${row.id} (${venture.slug}) — skipped`);
        candidates.push(candidate);
        continue;
      }
      throw new Error(tableErrorMessage(claimError.message, claimError.code, "framing_jobs", "006_whatsapp_framing.sql"));
    }

    const failJob = async (reason: string) => {
      candidate.status = "failed";
      candidate.detail = reason;
      console.error(`[poller] FRAMING FAILED: ${row.id} (${venture.slug}): ${reason}`);
      const { error: failError } = await getSupabase()
        .from("framing_jobs")
        .update({ status: "failed", error: reason })
        .eq("source_proposal_id", row.id);
      if (failError) {
        // Row stays 'running' — safe (never re-framed), but say so loudly.
        console.error(
          `[poller] CRITICAL: could not record the framing failure for ${row.id} (${failError.message}); ` +
            "its framing_jobs row remains 'running'",
        );
      }
    };

    if (sourceProblem) {
      await failJob(sourceProblem);
      candidates.push(candidate);
      continue;
    }

    let framedText: string;
    try {
      framedText = await frameForWhatsApp(briefText as string);
    } catch (err) {
      await failJob(err instanceof Error ? err.message : String(err));
      candidates.push(candidate);
      continue;
    }

    const { data: framedRow, error: insertError } = await getSupabase()
      .from("proposals")
      .insert(framedProposalRow({ id: row.id, venture_id: row.venture_id! }, framedText))
      .select("id")
      .single();
    if (insertError || !framedRow) {
      await failJob(
        `filing the framed proposal failed: ${insertError?.message ?? "no row returned"}` +
          (/proposals_action_check/.test(insertError?.message ?? "")
            ? " — run supabase/migrations/006_whatsapp_framing.sql (the action whitelist part)"
            : ""),
      );
      candidates.push(candidate);
      continue;
    }

    const framedId = (framedRow as { id: string }).id;
    const { error: doneError } = await getSupabase()
      .from("framing_jobs")
      .update({ status: "done", framed_proposal_id: framedId })
      .eq("source_proposal_id", row.id);
    candidate.status = "framed";
    candidate.framedProposalId = framedId;
    state.lastFramedAt = new Date().toISOString();
    if (doneError) {
      // The framed proposal exists; the job row stays 'running'. Deleting it
      // would frame (and file) a second copy — surface it instead.
      candidate.detail =
        `framed proposal ${framedId} filed, but recording 'done' failed: ${doneError.message}. ` +
        "The framing_jobs row remains 'running' — do NOT delete it.";
      console.error(`[poller] CRITICAL: ${candidate.detail}`);
    } else {
      console.log(`[poller] framed brief ${row.id} (${venture.slug}) → whatsapp.message proposal ${framedId}`);
    }
    candidates.push(candidate);
  }
  return candidates;
}

// --- Step C: post Approve/Reject prompts for pending proposals -------------

async function runPromptStep(channels: () => Promise<Map<string, SlackChannel>>): Promise<PromptCandidate[]> {
  const { data, error } = await getSupabase()
    .from("proposals")
    .select(PROPOSAL_COLS)
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

// --- Step D: disarm prompts whose proposal was decided elsewhere -----------

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
    .select(PROPOSAL_COLS)
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

// --- Step E: publish approved social posts via Blotato ---------------------

const MIGRATION_007 = "007_social_publishing.sql";
// Dry-run publishes must work end-to-end BEFORE the real key (and therefore
// before any real account id) exists; the logged would-send request carries
// this placeholder so the gap is visible, not hidden.
const DRY_RUN_ACCOUNT_PLACEHOLDER = "account-id-not-set";

const CALENDAR_COLS = "id, venture_id, body, media_urls, platforms, status, venture:ventures(name, slug)";

interface CalendarRow {
  id: string;
  venture_id: string;
  body: string;
  media_urls: string[];
  platforms: string[];
  status: string;
  venture: { name: string; slug: string } | null;
}

function normalizeCalendar(raw: unknown): CalendarRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.venture_id !== "string" || typeof row.body !== "string") return null;
  if (!Array.isArray(row.platforms)) return null;
  const ventureRaw = Array.isArray(row.venture) ? row.venture[0] : row.venture;
  let venture: CalendarRow["venture"] = null;
  if (typeof ventureRaw === "object" && ventureRaw !== null) {
    const v = ventureRaw as Record<string, unknown>;
    if (typeof v.name === "string" && typeof v.slug === "string") {
      venture = { name: v.name, slug: v.slug };
    }
  }
  return {
    id: row.id,
    venture_id: row.venture_id,
    body: row.body,
    media_urls: Array.isArray(row.media_urls) ? row.media_urls.filter((u): u is string => typeof u === "string") : [],
    platforms: row.platforms.filter((p): p is string => typeof p === "string"),
    status: typeof row.status === "string" ? row.status : "unknown",
    venture,
  };
}

const PUBLISH_LEDGER_STATUSES: readonly string[] = ["publishing", "submitted", "published", "failed", "dry-run"];

function normalizePublishRow(raw: unknown): PublishLedgerRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.calendar_id !== "string" || typeof d.platform !== "string") return null;
  if (typeof d.status !== "string" || !PUBLISH_LEDGER_STATUSES.includes(d.status)) return null;
  return {
    calendar_id: d.calendar_id,
    platform: d.platform,
    status: d.status as PublishLedgerStatus,
    submission_id: typeof d.submission_id === "string" ? d.submission_id : null,
    public_url: typeof d.public_url === "string" ? d.public_url : null,
    error: typeof d.error === "string" ? d.error : null,
  };
}

// Terminal failure before any claim exists (platform not configured, id
// missing): insert the failed row directly. First-write-wins like the other
// ledgers — a unique conflict means another run already recorded this pair.
async function recordPublishFailure(calendarId: string, platform: string, reason: string): Promise<void> {
  const { error } = await getSupabase()
    .from("social_publishes")
    .insert({ calendar_id: calendarId, platform, status: "failed", error: reason });
  if (error && error.code !== UNIQUE_VIOLATION) {
    throw new Error(tableErrorMessage(error.message, error.code, "social_publishes", MIGRATION_007));
  }
}

// Move a claimed ('publishing') or 'submitted' row to its next state. An
// update failure leaves the row where it was — safe (never re-claimed) but
// loud, same discipline as the delivery ledger.
async function finalizePublishRow(
  calendarId: string,
  platform: string,
  fromStatus: "publishing" | "submitted",
  patch: Record<string, unknown>,
): Promise<string | null> {
  const { error } = await getSupabase()
    .from("social_publishes")
    .update(patch)
    .eq("calendar_id", calendarId)
    .eq("platform", platform)
    .eq("status", fromStatus);
  if (error) {
    const detail =
      `recording '${String(patch.status)}' for ${calendarId}/${platform} failed: ${error.message}. ` +
      `The row remains '${fromStatus}' — do NOT delete it.`;
    console.error(`[poller] CRITICAL: ${detail}`);
    return detail;
  }
  return null;
}

// Roll the per-platform ledger up into the post's aggregate status, and —
// when this cycle actually changed an outcome — post the venture-channel
// summary with EVERY platform's current outcome (a partial failure must
// show the successes alongside). A post with dry-run rows stays
// 'publishing' on purpose: delete those rows once the real key exists and
// the next cycle re-arms the real publish.
async function settleCalendarRow(
  row: CalendarRow,
  rowLedger: Map<string, PublishLedgerRow>,
  changedThisCycle: boolean,
  channels: () => Promise<Map<string, SlackChannel>>,
): Promise<void> {
  const venture = row.venture!;
  const agg = aggregateCalendar(row.platforms, rowLedger);
  if (agg.complete && agg.status !== null) {
    const { error } = await getSupabase()
      .from("content_calendar")
      .update({ status: agg.status, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .in("status", ["approved", "publishing"]);
    if (error) {
      console.error(`[poller] could not record calendar status '${agg.status}' for post ${row.id}: ${error.message}`);
    } else {
      console.log(`[poller] post ${row.id} (${venture.slug}) settled as ${agg.status}`);
    }
  }

  if (!changedThisCycle) return;
  const outcomes = row.platforms
    .map((p) => rowLedger.get(p))
    .filter((r): r is PublishLedgerRow => r !== undefined)
    .map(outcomeFromRow)
    .filter((o): o is NonNullable<ReturnType<typeof outcomeFromRow>> => o !== null);
  if (outcomes.length === 0) return;
  const resolved = resolveChannel(await channels(), venture.slug);
  if ("failure" in resolved) {
    logOnce(
      `publish-summary:${row.id}`,
      `[poller] publish summary for post ${row.id} could not be posted: ${resolved.failure}`,
      true,
    );
    return;
  }
  const message = buildPublishSummary({
    ventureName: venture.name,
    postText: row.body,
    outcomes,
    publishedAt: new Date(),
  });
  try {
    await postMessage({ channel: resolved.channel.id, text: message.text, blocks: message.blocks });
  } catch (err) {
    logOnce(
      `publish-summary:${row.id}`,
      `[poller] publish summary post for ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

async function runPublishStep(channels: () => Promise<Map<string, SlackChannel>>): Promise<PublishCandidate[]> {
  const supabase = getSupabase();

  // Rejected sweep: a rejected proposal never runs apply_proposal, so its
  // calendar row would sit 'proposed' forever — the bot owns that flip.
  const { data: sweepData, error: sweepError } = await supabase
    .from("content_calendar")
    .select("id, proposal:proposals!content_calendar_proposal_id_fkey(status)")
    .eq("status", "proposed")
    .limit(DISARM_SCAN_LIMIT);
  if (sweepError) {
    throw new Error(tableErrorMessage(sweepError.message, sweepError.code, "content_calendar", MIGRATION_007));
  }
  for (const raw of sweepData ?? []) {
    const d = raw as Record<string, unknown>;
    const propRaw = Array.isArray(d.proposal) ? d.proposal[0] : d.proposal;
    const propStatus =
      typeof propRaw === "object" && propRaw !== null ? (propRaw as Record<string, unknown>).status : null;
    if (typeof d.id !== "string" || propStatus !== "rejected") continue;
    const { error } = await supabase
      .from("content_calendar")
      .update({ status: "rejected", updated_at: new Date().toISOString() })
      .eq("id", d.id)
      .eq("status", "proposed");
    if (error) console.error(`[poller] could not mark rejected post ${d.id}: ${error.message}`);
    else console.log(`[poller] post ${d.id} marked rejected (its social.post proposal was rejected)`);
  }

  // The publish work: every approved (or still-settling) post.
  const { data, error } = await supabase
    .from("content_calendar")
    .select(CALENDAR_COLS)
    .in("status", ["approved", "publishing"])
    .order("created_at", { ascending: true })
    .limit(POLL_LIMIT);
  if (error) throw new Error(tableErrorMessage(error.message, error.code, "content_calendar", MIGRATION_007));
  const rows = (data ?? [])
    .map(normalizeCalendar)
    .filter((r): r is CalendarRow => r !== null && r.venture !== null);
  if (rows.length === 0) return [];

  const { data: ledgerData, error: ledgerError } = await supabase
    .from("social_publishes")
    .select("calendar_id, platform, status, submission_id, public_url, error")
    .in(
      "calendar_id",
      rows.map((r) => r.id),
    );
  if (ledgerError) {
    throw new Error(tableErrorMessage(ledgerError.message, ledgerError.code, "social_publishes", MIGRATION_007));
  }
  const ledger = new Map<string, PublishLedgerRow>();
  for (const raw of ledgerData ?? []) {
    const r = normalizePublishRow(raw);
    if (r) ledger.set(`${r.calendar_id}:${r.platform}`, r);
  }

  const { data: vpData, error: vpError } = await supabase
    .from("venture_platforms")
    .select("venture_id, platform, blotato_account_id, blotato_page_id, youtube_privacy, enabled")
    .in("venture_id", [...new Set(rows.map((r) => r.venture_id))]);
  if (vpError) throw new Error(tableErrorMessage(vpError.message, vpError.code, "venture_platforms", MIGRATION_007));
  const stacks = new Map<string, Record<string, unknown>>();
  for (const raw of vpData ?? []) {
    const d = raw as Record<string, unknown>;
    if (typeof d.venture_id === "string" && typeof d.platform === "string") {
      stacks.set(`${d.venture_id}:${d.platform}`, d);
    }
  }

  const dryRun = isDryRun();
  const candidates: PublishCandidate[] = [];
  for (const row of rows) {
    const venture = row.venture!;

    if (row.platforms.length === 0) {
      logOnce(row.id, `[poller] PUBLISH FAILED: post ${row.id} (${venture.slug}) has no platforms — marking failed`, true);
      const { error: failErr } = await supabase
        .from("content_calendar")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .in("status", ["approved", "publishing"]);
      if (failErr) console.error(`[poller] could not mark platformless post ${row.id} failed: ${failErr.message}`);
      continue;
    }

    // The post is now the bot's: approved → publishing before any claim, so
    // the app always shows who owns the row.
    if (row.status === "approved") {
      const { error: flipError } = await supabase
        .from("content_calendar")
        .update({ status: "publishing", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "approved");
      if (flipError) console.error(`[poller] could not flip post ${row.id} to publishing: ${flipError.message}`);
    }

    const rowLedger = new Map<string, PublishLedgerRow>();
    for (const platform of row.platforms) {
      const existing = ledger.get(`${row.id}:${platform}`);
      if (existing) rowLedger.set(platform, existing);
    }

    let changed = false;
    for (const platform of row.platforms) {
      const candidate: PublishCandidate = {
        calendarId: row.id,
        platform,
        ventureSlug: venture.slug,
        ventureName: venture.name,
        status: "publishing-stuck",
      };
      const existing = rowLedger.get(platform);
      if (existing) {
        if (existing.status === "publishing") {
          candidate.detail =
            "claimed but never finalized (bot likely died mid-publish) — check the platform for the post; " +
            "delete the social_publishes row only if it is NOT there";
          logOnce(`${row.id}:${platform}`, `[poller] NEEDS ATTENTION: publish of ${row.id}/${platform} is ${candidate.detail}`, true);
        } else if (existing.status === "submitted") {
          candidate.status = "awaiting-confirmation";
          candidate.submissionId = existing.submission_id ?? undefined;
        } else if (existing.status === "published") {
          candidate.status = "published";
          candidate.publicUrl = existing.public_url ?? undefined;
        } else if (existing.status === "failed") {
          candidate.status = "previously-failed";
          candidate.detail = existing.error ?? "no reason recorded";
          logOnce(
            `${row.id}:${platform}`,
            `[poller] publish of ${row.id}/${platform} (${venture.slug}) previously failed: ${candidate.detail}`,
            true,
          );
        } else {
          candidate.status = "pending-real-key";
          candidate.detail = "dry run recorded — delete this social_publishes row once the real key exists to publish for real";
          logOnce(
            `${row.id}:${platform}`,
            `[poller] publish of ${row.id}/${platform} (${venture.slug}) is waiting on the real Blotato key (dry-run row in place)`,
            false,
          );
        }
        candidates.push(candidate);
        continue;
      }

      // Per-platform config comes ONLY from the post's own venture — the
      // venture-isolation guarantee lives in this lookup.
      const pv = stacks.get(`${row.venture_id}:${platform}`);
      let refuse: string | null = null;
      // The client publishes text posts to these two this phase; youtube
      // (video + per-post title) comes with the video phase.
      const supported = platform === "twitter" || platform === "linkedin" ? platform : null;
      if (!pv) {
        refuse = `platform ${platform} has no venture_platforms row for this venture — posts never cross ventures`;
      } else if (pv.enabled !== true) {
        refuse = `platform ${platform} is disabled in venture_platforms`;
      } else if (supported === null) {
        refuse =
          platform === "youtube"
            ? "youtube needs a per-post video and title — video posts land in a later phase"
            : `platform ${platform} is not yet supported by the Blotato client (twitter/linkedin only this phase)`;
      } else if (typeof pv.blotato_account_id !== "string" && !dryRun) {
        refuse =
          `blotato_account_id is not set for ${platform} — fetch ids via GET /admin/blotato-accounts ` +
          "(real key required) and assign them in the Supabase SQL editor";
      }
      if (refuse) {
        await recordPublishFailure(row.id, platform, refuse);
        rowLedger.set(platform, {
          calendar_id: row.id,
          platform,
          status: "failed",
          submission_id: null,
          public_url: null,
          error: refuse,
        });
        changed = true;
        candidate.status = "failed";
        candidate.detail = refuse;
        logOnce(`${row.id}:${platform}`, `[poller] PUBLISH FAILED: ${row.id}/${platform} (${venture.slug}): ${refuse}`, true);
        candidates.push(candidate);
        continue;
      }

      // CLAIM before publishing — same protocol as every other ledger; do
      // not reorder.
      const { error: claimError } = await supabase
        .from("social_publishes")
        .insert({ calendar_id: row.id, platform, status: "publishing" });
      if (claimError) {
        if (claimError.code === UNIQUE_VIOLATION) {
          candidate.detail = "another writer claimed this publish between read and claim — not publishing";
          console.error(`[poller] publish claim conflict on ${row.id}/${platform} (${venture.slug}) — skipped`);
          candidates.push(candidate);
          continue;
        }
        throw new Error(tableErrorMessage(claimError.message, claimError.code, "social_publishes", MIGRATION_007));
      }
      changed = true;

      const accountId =
        typeof pv!.blotato_account_id === "string" ? (pv!.blotato_account_id as string) : DRY_RUN_ACCOUNT_PLACEHOLDER;
      try {
        const request = buildPublishRequest({
          platform: supported!,
          accountId,
          text: row.body,
          mediaUrls: row.media_urls,
          linkedinPageId: typeof pv!.blotato_page_id === "string" ? (pv!.blotato_page_id as string) : undefined,
        });
        const result = await publishPost(request);
        if (result.dryRun) {
          const critical = await finalizePublishRow(row.id, platform, "publishing", { status: "dry-run" });
          rowLedger.set(platform, {
            calendar_id: row.id,
            platform,
            status: "dry-run",
            submission_id: null,
            public_url: null,
            error: null,
          });
          candidate.status = "dry-run";
          candidate.detail = critical ?? "request logged, nothing sent (no real key)";
          console.log(`[poller] dry-run publish recorded for ${row.id}/${platform} (${venture.slug})`);
        } else {
          const critical = await finalizePublishRow(row.id, platform, "publishing", {
            status: "submitted",
            submission_id: result.postSubmissionId,
          });
          rowLedger.set(platform, {
            calendar_id: row.id,
            platform,
            status: "submitted",
            submission_id: result.postSubmissionId,
            public_url: null,
            error: null,
          });
          candidate.status = "submitted";
          candidate.submissionId = result.postSubmissionId;
          if (critical) candidate.detail = critical;
          console.log(
            `[poller] submitted ${row.id}/${platform} (${venture.slug}) to Blotato (submission ${result.postSubmissionId})`,
          );
        }
        state.lastPublishActivityAt = new Date().toISOString();
      } catch (err) {
        // Terminal, per Blotato's own "do not retry on failed" — fix the
        // cause, delete the row, the next cycle re-arms.
        const reason = err instanceof Error ? err.message : String(err);
        candidate.status = "failed";
        candidate.detail = reason;
        console.error(`[poller] PUBLISH FAILED: ${row.id}/${platform} (${venture.slug}): ${reason}`);
        const critical = await finalizePublishRow(row.id, platform, "publishing", { status: "failed", error: reason });
        if (!critical) {
          rowLedger.set(platform, {
            calendar_id: row.id,
            platform,
            status: "failed",
            submission_id: null,
            public_url: null,
            error: reason,
          });
        }
        state.lastPublishActivityAt = new Date().toISOString();
      }
      candidates.push(candidate);
    }

    await settleCalendarRow(row, rowLedger, changed, channels);
  }
  return candidates;
}

// --- Step F: confirm submitted publishes against Blotato -------------------

async function runStatusPollStep(channels: () => Promise<Map<string, SlackChannel>>): Promise<PublishCandidate[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("social_publishes")
    .select("calendar_id, platform, status, submission_id, public_url, error")
    .eq("status", "submitted")
    .limit(POLL_LIMIT); // well under Blotato's 60 req/min on this endpoint
  if (error) throw new Error(tableErrorMessage(error.message, error.code, "social_publishes", MIGRATION_007));
  const submitted = (data ?? [])
    .map(normalizePublishRow)
    .filter((r): r is PublishLedgerRow => r !== null && r.submission_id !== null);
  if (submitted.length === 0) return [];

  const { data: calData, error: calError } = await supabase
    .from("content_calendar")
    .select(CALENDAR_COLS)
    .in("id", [...new Set(submitted.map((r) => r.calendar_id))]);
  if (calError) throw new Error(tableErrorMessage(calError.message, calError.code, "content_calendar", MIGRATION_007));
  const calendars = new Map(
    (calData ?? [])
      .map(normalizeCalendar)
      .filter((r): r is CalendarRow => r !== null && r.venture !== null)
      .map((r) => [r.id, r]),
  );

  const candidateFor = (r: PublishLedgerRow): PublishCandidate => ({
    calendarId: r.calendar_id,
    platform: r.platform,
    ventureSlug: calendars.get(r.calendar_id)?.venture?.slug ?? "?",
    ventureName: calendars.get(r.calendar_id)?.venture?.name ?? "?",
    status: "awaiting-confirmation",
    submissionId: r.submission_id ?? undefined,
  });

  // 'submitted' rows only ever come from real publishes; if the key has
  // since been removed or reset to the placeholder, say so instead of
  // failing the whole step every cycle.
  if (isDryRun()) {
    logOnce(
      "status-poll",
      "[poller] submitted publishes exist but BLOTATO_API_KEY is not a real key — outcomes cannot be confirmed until it returns",
      true,
    );
    return submitted.map((r) => {
      const c = candidateFor(r);
      c.detail = "cannot confirm: BLOTATO_API_KEY is not a real key";
      return c;
    });
  }

  const candidates: PublishCandidate[] = [];
  const changedCalendars = new Set<string>();
  for (const r of submitted) {
    const candidate = candidateFor(r);
    try {
      const status = await getPostStatus(r.submission_id!);
      if (status.status === "published") {
        const critical = await finalizePublishRow(r.calendar_id, r.platform, "submitted", {
          status: "published",
          public_url: status.publicUrl ?? null,
        });
        candidate.status = "published";
        candidate.publicUrl = status.publicUrl;
        if (critical) candidate.detail = critical;
        else changedCalendars.add(r.calendar_id);
        state.lastPublishActivityAt = new Date().toISOString();
        console.log(`[poller] publish confirmed: ${r.calendar_id}/${r.platform} → ${status.publicUrl ?? "(no url)"}`);
      } else if (status.status === "failed") {
        const reason = status.errorMessage ?? "Blotato reported failed (no reason given)";
        const critical = await finalizePublishRow(r.calendar_id, r.platform, "submitted", {
          status: "failed",
          error: reason,
        });
        candidate.status = "failed";
        candidate.detail = reason;
        if (critical) candidate.detail = `${reason}; ${critical}`;
        else changedCalendars.add(r.calendar_id);
        console.error(`[poller] PUBLISH FAILED at Blotato: ${r.calendar_id}/${r.platform}: ${reason}`);
      } else {
        candidate.detail = `Blotato reports ${status.status} — will check again next cycle`;
      }
    } catch (err) {
      // The status endpoint is a read — safe to retry next cycle, unlike a
      // publish.
      const message = err instanceof Error ? err.message : String(err);
      candidate.detail = `status check failed: ${message} — will retry next cycle`;
      logOnce(`status:${r.submission_id}`, `[poller] status check for ${r.calendar_id}/${r.platform} failed: ${message}`, true);
    }
    candidates.push(candidate);
  }

  // Confirmed or failed outcomes may have settled their posts: aggregate and
  // post the final summary for each affected post.
  for (const calId of changedCalendars) {
    const cal = calendars.get(calId);
    if (!cal) continue;
    const { data: rowData, error: rowError } = await supabase
      .from("social_publishes")
      .select("calendar_id, platform, status, submission_id, public_url, error")
      .eq("calendar_id", calId);
    if (rowError) {
      console.error(`[poller] could not reload the publish ledger for ${calId}: ${rowError.message}`);
      continue;
    }
    const rowLedger = new Map<string, PublishLedgerRow>();
    for (const raw of rowData ?? []) {
      const r = normalizePublishRow(raw);
      if (r) rowLedger.set(r.platform, r);
    }
    await settleCalendarRow(cal, rowLedger, true, channels);
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
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const stepErrors: string[] = [];
  try {
    // Slack's channel roster is fetched at most once per cycle, and only if
    // some step actually needs it.
    let channelsPromise: Promise<Map<string, SlackChannel>> | null = null;
    const channels = () => (channelsPromise ??= listChannelsByName());

    const { briefs, whatsapp } = await fetchApprovedWork();

    try {
      state.lastDeliveries = await runDeliveryStep(briefs, whatsapp, channels);
    } catch (err) {
      stepErrors.push(`delivery: ${errorText(err)}`);
    }
    try {
      state.lastFramings = await runFramingStep(briefs);
    } catch (err) {
      stepErrors.push(`framing: ${errorText(err)}`);
    }
    let prompts: PromptCandidate[] = [];
    try {
      prompts = await runPromptStep(channels);
    } catch (err) {
      stepErrors.push(`prompts: ${errorText(err)}`);
    }
    let disarmed: PromptCandidate[] = [];
    try {
      disarmed = await runDisarmStep();
    } catch (err) {
      stepErrors.push(`disarm: ${errorText(err)}`);
    }
    state.lastPrompts = [...prompts, ...disarmed];
    let published: PublishCandidate[] = [];
    try {
      published = await runPublishStep(channels);
    } catch (err) {
      stepErrors.push(`publish: ${errorText(err)}`);
    }
    try {
      const confirmed = await runStatusPollStep(channels);
      // The confirm pass has the fresher word on any (post, platform) both
      // passes touched this cycle.
      const byKey = new Map(published.map((c) => [`${c.calendarId}:${c.platform}`, c]));
      for (const c of confirmed) byKey.set(`${c.calendarId}:${c.platform}`, c);
      published = [...byKey.values()];
    } catch (err) {
      stepErrors.push(`confirm: ${errorText(err)}`);
    }
    state.lastPublishes = published;

    state.lastCheckAt = startedAt;
    if (stepErrors.length === 0) {
      state.lastSuccessAt = startedAt;
      state.lastCheckOk = true;
      state.lastCheckError = null;
    } else {
      state.lastCheckOk = false;
      state.lastCheckError = stepErrors.join("; ");
      console.error(`[poller] cycle finished with step failures — ${state.lastCheckError}`);
    }
  } catch (err) {
    // The shared proposals fetch (or something structural) failed — nothing
    // downstream could run.
    const message = errorText(err);
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
  console.log(
    `[poller] started (every ${POLL_INTERVAL_MS / 1000}s: deliveries, WhatsApp framing, approval prompts, disarm, ` +
      "social publish, publish confirm)",
  );
  const tick = () => {
    runPollCycle().catch((err) => {
      console.error("[poller] tick failed unexpectedly:", err);
    });
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
