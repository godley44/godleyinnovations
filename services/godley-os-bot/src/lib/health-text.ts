// The health-probe text, shared by the @mention probe (slack-events) and
// the AI Manager's `health` tool — one implementation so the two surfaces
// can never disagree. Pure: state comes in as arguments.

import { formatUtc } from "./brief-blocks.js";
import type { ManagerStats } from "./manager-state.js";
import type { PollerState } from "./report-poller.js";
import { BOT_VERSION } from "./version.js";

export function buildHealthText(state: PollerState, manager: ManagerStats): string {
  const poller = state.intervalRunning ? "running" : "NOT RUNNING";
  const lastOk = state.lastSuccessAt ? formatUtc(new Date(state.lastSuccessAt)) : "never";
  const lastDelivered = state.lastDeliveredAt ? formatUtc(new Date(state.lastDeliveredAt)) : "none yet";
  const lastPrompt = state.lastPromptPostedAt ? formatUtc(new Date(state.lastPromptPostedAt)) : "none yet";
  const failure =
    state.lastCheckOk === false ? ` Last check FAILED: ${state.lastCheckError ?? "unknown error"}.` : "";
  const lastFramed = state.lastFramedAt ? formatUtc(new Date(state.lastFramedAt)) : "none yet";
  const lastPublish = state.lastPublishActivityAt ? formatUtc(new Date(state.lastPublishActivityAt)) : "none yet";
  const needsAttention = (s: string) =>
    s === "failed" ||
    s === "previously-failed" ||
    s === "posting-stuck" ||
    s === "already-disarmed" ||
    s === "framing-stuck" ||
    s === "publishing-stuck";
  const attention =
    state.lastDeliveries.filter((c) => needsAttention(c.status)).length +
    state.lastPrompts.filter((c) => needsAttention(c.status)).length +
    state.lastFramings.filter((c) => needsAttention(c.status)).length +
    state.lastPublishes.filter((c) => needsAttention(c.status)).length;
  const awaiting = state.lastPrompts.filter(
    (c) => c.status === "posted" || c.status === "already-posted",
  ).length;
  const waitingOnKey = state.lastPublishes.filter(
    (c) => c.status === "dry-run" || c.status === "pending-real-key",
  ).length;
  const pendingConfirm = state.lastPublishes.filter(
    (c) => c.status === "submitted" || c.status === "awaiting-confirmation",
  ).length;
  const lastModel =
    manager.lastModelLatencyMs !== null && manager.lastModelAt
      ? `${manager.lastModelLatencyMs}ms at ${formatUtc(new Date(manager.lastModelAt))}`
      : "none yet";
  return (
    `godley-os-bot v${BOT_VERSION} · poller: ${poller} · last successful check: ${lastOk} · ` +
    `approvals awaiting decision in Slack: ${awaiting} · last buttons post: ${lastPrompt} · ` +
    `last report delivered: ${lastDelivered} · last WhatsApp framing: ${lastFramed} · ` +
    `last publish activity: ${lastPublish} · publishes waiting on the real Blotato key: ${waitingOnKey} · ` +
    `publishes pending confirmation: ${pendingConfirm} · needs attention: ${attention} · ` +
    `manager: ${manager.messagesHandled} message(s) handled · ` +
    `pending confirmations: ${manager.pendingActions} · last model call: ${lastModel}.${failure}`
  );
}
