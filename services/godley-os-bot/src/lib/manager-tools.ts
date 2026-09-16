// The AI Manager's tool surface. Two kinds, split on purpose:
//
//  READ tools — executed immediately, no confirmation: they only query
//  Supabase / process state and return JSON for the model to narrate.
//
//  ACT tools — NEVER executed here. They are DEFINITIONS ONLY: when the
//  model calls one, src/lib/manager.ts parks it as a pending action and
//  asks the owner to confirm. Execution (after "yes") goes through
//  src/lib/manager-acts.ts, which reuses the buttons' code paths. Keeping
//  the executors out of this module makes "ACT tools never execute without
//  a confirmed pending action" a structural property, not a convention.

import type { AnthropicTool } from "../integrations/anthropic.js";
import { buildHealthText } from "./health-text.js";
import { getManagerStats } from "./manager-state.js";
import type { ActToolName } from "./pending-actions.js";
import { getPollerState } from "./report-poller.js";
import { getSupabase } from "./supabase.js";

export const ACT_TOOL_NAMES: readonly ActToolName[] = [
  "approve_proposal",
  "reject_proposal",
  "create_social_draft",
];

export function isActTool(name: string): name is ActToolName {
  return (ACT_TOOL_NAMES as readonly string[]).includes(name);
}

export const MANAGER_TOOLS: AnthropicTool[] = [
  {
    name: "list_pending_proposals",
    description:
      "List every PENDING proposal across all ventures — the owner's approval inbox. " +
      "Returns id, venture, action, proposed_by, age, and a short payload preview per proposal.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_proposal",
    description:
      "Fetch one proposal by id, with its FULL payload and status. Use it before acting on a " +
      "proposal, or when the owner asks what exactly a proposal contains.",
    input_schema: {
      type: "object",
      properties: {
        proposal_id: { type: "string", description: "The proposal's uuid, from list_pending_proposals or recent_activity." },
      },
      required: ["proposal_id"],
      additionalProperties: false,
    },
  },
  {
    name: "recent_activity",
    description:
      "Recent activity across all ventures: the latest decided proposals, Slack report deliveries, " +
      "social publishes, and WhatsApp framings (newest first).",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Items per category, 1-25. Default 10." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "venture_overview",
    description:
      "All ventures with their status, social platform stacks (enabled? account configured?), and " +
      "how many proposals each has pending.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "health",
    description:
      "The bot's own health line — poller status, last delivery/framing/publish activity, items " +
      "needing attention, and manager stats. Same data as the @mention health probe.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  // --- ACT tools: definitions only; see the module header -----------------
  {
    name: "approve_proposal",
    description:
      "APPROVE a pending proposal (performs the proposed write via the OS's apply_proposal " +
      "transaction). The system will ask the owner to confirm before anything runs — never claim " +
      "the approval happened after calling this.",
    input_schema: {
      type: "object",
      properties: {
        proposal_id: { type: "string", description: "The pending proposal's uuid, from a tool result in this conversation." },
      },
      required: ["proposal_id"],
      additionalProperties: false,
    },
  },
  {
    name: "reject_proposal",
    description:
      "REJECT a pending proposal (nothing is written; the proposal is closed). The system will ask " +
      "the owner to confirm before anything runs — never claim the rejection happened after calling this.",
    input_schema: {
      type: "object",
      properties: {
        proposal_id: { type: "string", description: "The pending proposal's uuid, from a tool result in this conversation." },
      },
      required: ["proposal_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_social_draft",
    description:
      "File a social post DRAFT for a venture: creates the calendar row and a social.post proposal " +
      "that still needs approval before anything publishes. The mildest action — it publishes " +
      "nothing by itself. The system will ask the owner to confirm before filing.",
    input_schema: {
      type: "object",
      properties: {
        venture_slug: { type: "string", description: 'The venture\'s slug, e.g. "lil-bull".' },
        text: { type: "string", description: "The exact post body." },
        platforms: {
          type: "array",
          items: { type: "string" },
          description: 'Target platforms, a subset of the venture\'s enabled stack, e.g. ["twitter","linkedin"].',
        },
      },
      required: ["venture_slug", "text", "platforms"],
      additionalProperties: false,
    },
  },
];

// --- READ tool executors ----------------------------------------------------

const PREVIEW_MAX = 140;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function preview(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return truncate(text.trim(), PREVIEW_MAX);
  }
  try {
    return truncate(JSON.stringify(payload ?? {}), PREVIEW_MAX);
  } catch {
    return "(unreadable payload)";
  }
}

export function formatAge(fromIso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function ventureName(raw: unknown): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const name = (v as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "(unknown venture)";
}

async function listPendingProposals(): Promise<unknown> {
  const { data, error } = await getSupabase()
    .from("proposals")
    .select("id, created_at, action, proposed_by, payload, venture:ventures(name, slug)")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_LIMIT);
  if (error) throw new Error(`proposals query failed: ${error.message}`);
  const rows = (data ?? []).map((raw) => {
    const d = raw as Record<string, unknown>;
    return {
      id: d.id,
      venture: ventureName(d.venture),
      action: d.action,
      proposed_by: d.proposed_by,
      age: typeof d.created_at === "string" ? formatAge(d.created_at) : "?",
      preview: preview(d.payload),
    };
  });
  return { pending_count: rows.length, proposals: rows };
}

async function getProposal(input: Record<string, unknown>): Promise<unknown> {
  const id = typeof input.proposal_id === "string" ? input.proposal_id.trim() : "";
  if (!id) throw new Error("proposal_id is required");
  const { data, error } = await getSupabase()
    .from("proposals")
    .select("id, status, action, proposed_by, created_at, decided_at, payload, venture:ventures(name, slug)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`proposals query failed: ${error.message}`);
  if (!data) throw new Error(`no proposal with id ${id}`);
  const d = data as Record<string, unknown>;
  return {
    id: d.id,
    status: d.status,
    action: d.action,
    proposed_by: d.proposed_by,
    venture: ventureName(d.venture),
    created_at: d.created_at,
    decided_at: d.decided_at,
    payload: d.payload,
  };
}

// Each sub-list fails independently (a missing migration must not blank the
// whole overview) — errors surface as { error } in that category.
async function recentActivity(input: Record<string, unknown>): Promise<unknown> {
  const rawLimit = typeof input.limit === "number" ? Math.floor(input.limit) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
  const supabase = getSupabase();

  const capture = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await run();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const decisions = capture(async () => {
    const { data, error } = await supabase
      .from("proposals")
      .select("id, status, action, proposed_by, decided_at, venture:ventures(name)")
      .neq("status", "pending")
      .not("decided_at", "is", null)
      .order("decided_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((raw) => {
      const d = raw as Record<string, unknown>;
      return {
        proposal_id: d.id,
        venture: ventureName(d.venture),
        action: d.action,
        proposed_by: d.proposed_by,
        decision: d.status,
        decided_at: d.decided_at,
      };
    });
  });

  const deliveries = capture(async () => {
    const { data, error } = await supabase
      .from("slack_deliveries")
      .select("proposal_id, status, error, created_at, proposal:proposals(action, venture:ventures(name))")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((raw) => {
      const d = raw as Record<string, unknown>;
      const prop = (Array.isArray(d.proposal) ? d.proposal[0] : d.proposal) as Record<string, unknown> | null;
      return {
        proposal_id: d.proposal_id,
        venture: ventureName(prop?.venture),
        action: prop?.action ?? "?",
        status: d.status,
        error: d.error,
        at: d.created_at,
      };
    });
  });

  const publishes = capture(async () => {
    const { data, error } = await supabase
      .from("social_publishes")
      .select("calendar_id, platform, status, public_url, error, created_at, calendar:content_calendar(venture:ventures(name))")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((raw) => {
      const d = raw as Record<string, unknown>;
      const cal = (Array.isArray(d.calendar) ? d.calendar[0] : d.calendar) as Record<string, unknown> | null;
      return {
        calendar_id: d.calendar_id,
        venture: ventureName(cal?.venture),
        platform: d.platform,
        status: d.status,
        public_url: d.public_url,
        error: d.error,
        at: d.created_at,
      };
    });
  });

  const framings = capture(async () => {
    const { data, error } = await supabase
      .from("framing_jobs")
      .select("source_proposal_id, framed_proposal_id, status, error, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

  return {
    decisions: await decisions,
    deliveries: await deliveries,
    publishes: await publishes,
    framings: await framings,
  };
}

async function ventureOverview(): Promise<unknown> {
  const supabase = getSupabase();
  const { data: ventures, error: vError } = await supabase
    .from("ventures")
    .select("id, name, slug, status")
    .order("name", { ascending: true });
  if (vError) throw new Error(`ventures query failed: ${vError.message}`);

  const { data: platforms, error: pError } = await supabase
    .from("venture_platforms")
    .select("venture_id, platform, enabled, blotato_account_id");
  if (pError) throw new Error(`venture_platforms query failed: ${pError.message}`);

  const { data: pending, error: pendError } = await supabase
    .from("proposals")
    .select("venture_id")
    .eq("status", "pending");
  if (pendError) throw new Error(`proposals query failed: ${pendError.message}`);

  const pendingByVenture = new Map<string, number>();
  for (const raw of pending ?? []) {
    const id = (raw as Record<string, unknown>).venture_id;
    if (typeof id === "string") pendingByVenture.set(id, (pendingByVenture.get(id) ?? 0) + 1);
  }

  return (ventures ?? []).map((raw) => {
    const v = raw as Record<string, unknown>;
    const stack = (platforms ?? [])
      .map((p) => p as Record<string, unknown>)
      .filter((p) => p.venture_id === v.id)
      .map((p) => ({
        platform: p.platform,
        enabled: p.enabled === true,
        account_configured: typeof p.blotato_account_id === "string",
      }));
    return {
      name: v.name,
      slug: v.slug,
      status: v.status,
      platforms: stack,
      pending_proposals: pendingByVenture.get(v.id as string) ?? 0,
    };
  });
}

// Executes a READ tool and returns the tool_result content. ACT tool names
// are refused loudly — reaching here with one is a bug in the manager loop.
export async function runReadTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "list_pending_proposals":
      return JSON.stringify(await listPendingProposals());
    case "get_proposal":
      return JSON.stringify(await getProposal(input));
    case "recent_activity":
      return JSON.stringify(await recentActivity(input));
    case "venture_overview":
      return JSON.stringify(await ventureOverview());
    case "health":
      return buildHealthText(getPollerState(), getManagerStats());
    default:
      throw new Error(`not a READ tool: ${name}`);
  }
}
