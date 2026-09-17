// THE decision code path — approve/reject exactly as the Slack buttons do
// it, extracted from src/routes/slack-interactions.ts so the AI Manager and
// the buttons run literally the same functions. No surface may grow its own
// approval logic: approve is the apply_proposal RPC (approving IS the
// write, one transaction), reject is the pending-guarded status update.
//
// disarmDecidedPrompt is the manager-side reuse of the PR #5 disarm logic:
// after a decision made OUTSIDE the buttons, re-render the buttons message
// to the decided layout (buildDecidedMessage + chat.update — the same
// building blocks as the poller's disarm step) and mark the ledger row
// disarmed. Best-effort by design: any failure here is only logged, because
// the poller's disarm pass repairs un-disarmed prompts within a cycle.

import { buildDecidedMessage } from "./approval-blocks.js";
import { getSupabase } from "./supabase.js";
import { updateMessage } from "./slack-web.js";

// Single-operator system — the only human who can decide is the owner (see
// is_owner() in migration 001).
export const DECIDER_NAME = "Justin";

export type Decision = "approve" | "reject";

export async function recordDecision(decision: Decision, proposalId: string): Promise<void> {
  const supabase = getSupabase();
  if (decision === "approve") {
    const { error } = await supabase.rpc("apply_proposal", { p_id: proposalId });
    if (error) throw new Error(error.message);
    return;
  }
  const { data, error } = await supabase
    .from("proposals")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("proposal not found or already decided");
  }
}

// Mark the prompt's ledger row disarmed so the poller's disarm pass doesn't
// re-render the message. 'posting' is included: acting on the proposal
// proves the pipeline is live, healing a row stuck by a crash-before-record.
// Failure here is only logged — the poller repairs un-marked prompts on its
// next cycle.
export async function markPromptDisarmed(proposalId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("slack_prompts")
    .update({ status: "disarmed", disarmed_at: new Date().toISOString() })
    .eq("proposal_id", proposalId)
    .in("status", ["posted", "posting"]);
  if (error) {
    console.error(
      `[decisions] could not mark prompt ${proposalId} disarmed (${error.message}) — ` +
        "the poller's disarm pass will repair it",
    );
  }
}

// Retire the buttons message for a proposal decided outside the buttons
// (manager or app inbox): chat.update it to the decided layout, then mark
// the ledger row. Returns a short human-readable outcome for the caller's
// reply; never throws.
export async function disarmDecidedPrompt(proposalId: string, via: string): Promise<string> {
  try {
    const { data, error } = await getSupabase()
      .from("slack_prompts")
      .select("status, channel_id, message_ts")
      .eq("proposal_id", proposalId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { status?: unknown; channel_id?: unknown; message_ts?: unknown } | null;
    if (!row || row.status === "disarmed") {
      return "no live buttons message to disarm";
    }
    if (
      typeof row.channel_id !== "string" ||
      typeof row.message_ts !== "string" ||
      (row.status !== "posted" && row.status !== "posting")
    ) {
      // Nothing render-able (failed prompt, or claimed but never posted) —
      // just make sure the ledger can't re-arm it.
      await markPromptDisarmed(proposalId);
      return "no live buttons message to disarm";
    }

    const { data: pData, error: pError } = await getSupabase()
      .from("proposals")
      .select("action, proposed_by, status, decided_at, venture:ventures(name)")
      .eq("id", proposalId)
      .maybeSingle();
    if (pError || !pData) throw new Error(pError?.message ?? "proposal not found after decision");
    const prop = pData as {
      action?: unknown;
      proposed_by?: unknown;
      status?: unknown;
      decided_at?: unknown;
      venture?: unknown;
    };
    const ventureRaw = Array.isArray(prop.venture) ? prop.venture[0] : prop.venture;
    const ventureName = (ventureRaw as { name?: unknown } | null)?.name;
    if (typeof prop.action !== "string" || typeof ventureName !== "string") {
      throw new Error("proposal row missing action/venture");
    }

    const decided = buildDecidedMessage({
      decision: prop.status === "approved" ? "approve" : "reject",
      ventureName,
      action: prop.action,
      proposedBy: typeof prop.proposed_by === "string" ? prop.proposed_by : "automation",
      decidedAt: typeof prop.decided_at === "string" ? new Date(prop.decided_at) : new Date(),
      via,
    });
    await updateMessage({
      channel: row.channel_id,
      ts: row.message_ts,
      text: decided.text,
      blocks: decided.blocks,
    });
    await markPromptDisarmed(proposalId);
    return "the buttons message has been disarmed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[decisions] disarm of the buttons for ${proposalId} failed (${message}) — ` +
        "the poller's disarm pass will repair it",
    );
    return "the buttons message could not be updated yet (the poller will repair it within a minute)";
  }
}
