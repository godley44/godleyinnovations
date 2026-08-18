// POST /slack/interactions — Slack interactivity endpoint (form-encoded, the
// "payload" field is JSON).
//
// Approve/Reject buttons land here. IMPORTANT MAPPING: what the product calls
// "approvals" is the public.proposals table (migration 002) — the same rows
// the app's Approvals inbox shows. There is no separate "approvals" relation,
// and approving is NOT a bare status update:
//
//   approve → rpc apply_proposal(p_id): performs the proposed write (ledger
//             row / ticket / note), flips status to 'approved' and sets
//             decided_at — one transaction, exactly like the Approve button
//             in the app (src/components/ApprovalsCard.tsx). Updating status
//             directly would strand the payload forever, because
//             apply_proposal refuses anything that isn't pending.
//   reject  → update proposals set status='rejected', decided_at=now()
//             where id=? and status='pending'  (the pending guard means an
//             already-decided proposal is never flipped).
//
// The button's `value` must carry the proposal id (whatever posts the
// approval message later is responsible for that).
//
// Ordering: Slack needs its ack within 3 seconds, so the route returns 200
// immediately and the decision is recorded after, with the outcome delivered
// through the payload's response_url (valid for 30 minutes). A failed write
// is never swallowed: it is reported in-channel and nothing else happens.

import { Hono } from "hono";
import { slackVerify, type SlackVerifiedEnv } from "../lib/slack-verify.js";
import { getSupabase } from "../lib/supabase.js";

// Single-operator system — the only human who can click these buttons is the
// owner (see is_owner() in migration 001).
const DECIDER_NAME = "Justin";

interface BlockAction {
  action_id?: string;
  value?: string;
}

interface InteractionPayload {
  type?: string;
  response_url?: string;
  actions?: BlockAction[];
}

type Decision = "approve" | "reject";

async function respond(responseUrl: string, body: object): Promise<void> {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Slack response_url returned ${res.status}`);
}

async function recordDecision(decision: Decision, proposalId: string): Promise<void> {
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

async function handleDecision(
  decision: Decision,
  proposalId: string,
  responseUrl: string,
): Promise<void> {
  try {
    await recordDecision(decision, proposalId);
  } catch (err) {
    // Stop on failure — report it in-channel, leave the original message (and
    // its buttons) in place so the decision can be retried.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[interactions] ${decision} failed for proposal ${proposalId}: ${message}`);
    await respond(responseUrl, {
      replace_original: false,
      response_type: "in_channel",
      text: `⚠️ Could not record the ${decision} decision — the database write failed: ${message}`,
    });
    return;
  }
  await respond(responseUrl, {
    replace_original: true,
    text: decision === "approve" ? `✅ Approved by ${DECIDER_NAME}` : `❌ Rejected by ${DECIDER_NAME}`,
  });
}

export const slackInteractions = new Hono<SlackVerifiedEnv>();

slackInteractions.post("/", slackVerify, (c) => {
  const rawBody = c.get("rawBody");

  const payloadJson = new URLSearchParams(rawBody).get("payload");
  if (!payloadJson) return c.text("missing payload field", 400);

  let payload: InteractionPayload;
  try {
    payload = JSON.parse(payloadJson) as InteractionPayload;
  } catch {
    return c.text("payload must be JSON", 400);
  }

  if (payload.type !== "block_actions") return c.body(null, 200);

  const action = payload.actions?.[0];
  const actionId = action?.action_id;
  if (actionId !== "approve" && actionId !== "reject") return c.body(null, 200);

  const responseUrl = payload.response_url;
  if (!responseUrl) {
    // Can't report anywhere without it; log loudly and ack so Slack doesn't
    // show the user a generic failure for something we can't fix by retry.
    console.error("[interactions] block_actions without response_url — dropped");
    return c.body(null, 200);
  }

  const proposalId = action?.value;
  const finish = proposalId
    ? handleDecision(actionId, proposalId, responseUrl)
    : // A button without a proposal id is a bug in whatever posted the
      // message — say so in the channel instead of guessing.
      respond(responseUrl, {
        replace_original: false,
        response_type: "in_channel",
        text: `⚠️ This ${actionId} button carries no proposal id — it was posted wrong and nothing was written.`,
      });

  // Ack now (3-second rule); the work above completes via response_url.
  finish.catch((err) => console.error("[interactions] follow-up failed:", err));
  return c.body(null, 200);
});
