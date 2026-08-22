// Report delivery poller — currently DISCOVERY MODE, deliberately not
// posting.
//
// What a cycle does: find reports that are ready for Slack — proposals with
// action='note.append', proposed_by='weekly-insight', status='approved'
// (approved is the gate on purpose: the brief reaches a channel only after
// the owner signed it, same as every other automated write) — and resolve
// where each would go (channel name = ventures.slug, src/lib/venture-map.ts
// convention, here in the venture→channel direction).
//
// Why it does not post yet: the bot must never double-post a report across
// restarts, which requires delivery state in the database — and the current
// schema has NO table or column that can hold it (proposals tracks only the
// approval decision; ventures.notes is the approved text itself). Schema is
// never invented here; a slack_deliveries migration is proposed and awaiting
// the owner's approval. Until it lands, cycles log what they WOULD deliver
// and DELIVERY_ENABLED stays false. The posting step plugs into the one
// place marked below.

import { buildBriefMessage } from "./brief-blocks.js";
import { getSupabase } from "./supabase.js";
import { listChannelsByName } from "./slack-web.js";

// Flips to true only when delivery tracking exists in the database (the
// proposed slack_deliveries migration) and the posting step is implemented
// against it.
export const DELIVERY_ENABLED = false;

const POLL_INTERVAL_MS = 60 * 1000;
const POLL_LIMIT = 10;

export type CandidateStatus =
  | "would-deliver" // channel found, bot is a member, blocks build cleanly
  | "channel-not-found"
  | "bot-not-in-channel"
  | "bad-payload"
  | "not-checked"; // background cycles skip Slack; only /admin/deliver-now resolves channels

export interface DeliveryCandidate {
  proposalId: string;
  ventureSlug: string;
  ventureName: string;
  generatedAt: string;
  approvedAt: string | null;
  status: CandidateStatus;
  channelId?: string;
  blockCount?: number;
  detail?: string;
}

export interface PollerState {
  intervalRunning: boolean;
  deliveryEnabled: boolean;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  lastCandidates: DeliveryCandidate[];
}

const state: PollerState = {
  intervalRunning: false,
  deliveryEnabled: DELIVERY_ENABLED,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastCheckOk: null,
  lastCheckError: null,
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

// Log each standing problem/would-deliver once per proposal per process, not
// every 60 seconds.
const loggedProposals = new Set<string>();

function logOnce(proposalId: string, message: string, isError: boolean): void {
  const key = `${proposalId}:${message}`;
  if (loggedProposals.has(key)) return;
  loggedProposals.add(key);
  if (isError) console.error(message);
  else console.log(message);
}

export interface CycleResult {
  skipped: boolean;
  state: PollerState;
}

let cycleInFlight = false;

export async function runPollCycle(opts: { resolveChannels: boolean }): Promise<CycleResult> {
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

    const channels = opts.resolveChannels ? await listChannelsByName() : null;
    const candidates: DeliveryCandidate[] = [];

    for (const raw of data ?? []) {
      const row = normalizeRow(raw);
      if (!row || !row.venture) {
        console.error(`[poller] proposals row missing id/venture embed — skipped: ${JSON.stringify(raw).slice(0, 200)}`);
        continue;
      }
      const candidate: DeliveryCandidate = {
        proposalId: row.id,
        ventureSlug: row.venture.slug,
        ventureName: row.venture.name,
        generatedAt: row.created_at,
        approvedAt: row.decided_at,
        status: "not-checked",
      };

      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const briefText = payload.text;
      if (typeof briefText !== "string" || !briefText.trim()) {
        candidate.status = "bad-payload";
        candidate.detail = "payload.text is missing or empty — nothing to post";
        logOnce(row.id, `[poller] DELIVERY FAILED (would be): proposal ${row.id} (${row.venture.slug}): ${candidate.detail}`, true);
        candidates.push(candidate);
        continue;
      }

      if (channels) {
        const channel = channels.get(row.venture.slug);
        if (!channel) {
          candidate.status = "channel-not-found";
          candidate.detail = `no public Slack channel named #${row.venture.slug} (channel name must equal ventures.slug)`;
          logOnce(row.id, `[poller] DELIVERY BLOCKED: proposal ${row.id}: ${candidate.detail}`, true);
        } else if (!channel.isMember) {
          candidate.status = "bot-not-in-channel";
          candidate.channelId = channel.id;
          candidate.detail = `bot is not a member of #${row.venture.slug} (${channel.id}) — invite it with /invite`;
          logOnce(row.id, `[poller] DELIVERY BLOCKED: proposal ${row.id}: ${candidate.detail}`, true);
        } else {
          const message = buildBriefMessage({
            briefText,
            ventureName: row.venture.name,
            generatedAt: new Date(row.created_at),
          });
          candidate.status = "would-deliver";
          candidate.channelId = channel.id;
          candidate.blockCount = message.blocks.length;
        }
      }

      if (candidate.status === "would-deliver" || candidate.status === "not-checked") {
        // <-- Posting plugs in here once delivery tracking exists in the
        // database: claim the report in slack_deliveries, chat.postMessage,
        // record the outcome. Until then, say what would happen.
        logOnce(
          row.id,
          `[poller] approved brief ${row.id} (${row.venture.slug}) ready — delivery disabled, awaiting the slack-delivery tracking migration`,
          false,
        );
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
  console.log(
    `[poller] started (every ${POLL_INTERVAL_MS / 1000}s, discovery mode — Slack delivery ${DELIVERY_ENABLED ? "ENABLED" : "disabled until the delivery-tracking migration is approved"})`,
  );
  // Background cycles stay off the Slack API (nothing to post yet);
  // /admin/deliver-now runs the full resolution on demand.
  const tick = () => {
    runPollCycle({ resolveChannels: false }).catch((err) => {
      console.error("[poller] tick failed unexpectedly:", err);
    });
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
