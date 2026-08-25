// Unit tests for the approval-prompt Block Kit builders. The button asserts
// are the interactions contract (src/routes/slack-interactions.ts) written
// as tests: action_id "approve"/"reject", proposal id in value — if these
// fail, taps stop reaching apply_proposal.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovalPrompt, buildDecidedMessage } from "./approval-blocks.js";
import type { SlackBlock, SlackButton } from "./brief-blocks.js";

const PROPOSAL_ID = "3d0f8a9e-1111-2222-3333-444455556666";
const CREATED_AT = new Date("2026-08-24T13:02:00Z");

// Realistic weekly-insight pending payload: a brief well over the preview cap.
const LONG_BRIEF =
  "Lil Bull Weekly Market Brief — week of 2026-08-24\n\n" +
  "S&P 500: Bullish - key level 7652.86 (daily SMA50)\n" +
  "SNDK: Neutral - key level $1493.12 (latest close)\n" +
  "INTEL: Bearish - key level $84.20 (20-session low)\n\n" +
  "Timeframes:\n" +
  "S&P 500: 1H MA↑(3b) MACD+↑ SRSI 62 | 1D +1.2% MA↑(21b) MACD+↑ SRSI 71ob | 1W +2.4% MA↑(8b) MACD+↑ SRSI 55\n\n" +
  "Sentiment: Broad risk appetite held up through options expiry into S&P 500 trackers. ".repeat(8) +
  "\n\nAnalysis, not financial advice — trade your own plan.";

function weeklyPrompt() {
  return buildApprovalPrompt({
    proposalId: PROPOSAL_ID,
    ventureName: "Lil Bull",
    action: "note.append",
    proposedBy: "weekly-insight",
    createdAt: CREATED_AT,
    payload: { text: LONG_BRIEF },
  });
}

function sectionTexts(blocks: SlackBlock[]): string[] {
  return blocks.filter((b) => b.type === "section").map((b) => b.text.text);
}

function buttons(blocks: SlackBlock[]): SlackButton[] {
  const actions = blocks.find((b) => b.type === "actions");
  return actions?.type === "actions" ? actions.elements : [];
}

test("prompt header carries venture name; meta line has action, source, UTC time", () => {
  const { blocks } = weeklyPrompt();
  const header = blocks[0];
  assert.equal(header?.type, "header");
  assert.equal(header?.type === "header" ? header.text.text : "", "Approval needed — Lil Bull");
  const meta = sectionTexts(blocks)[0] ?? "";
  assert.match(meta, /\*note\.append\* proposed by \*weekly-insight\* · 2026-08-24 13:02 UTC/);
});

test("buttons match the interactions contract exactly", () => {
  const found = buttons(weeklyPrompt().blocks);
  assert.equal(found.length, 2);
  const [approve, reject] = found;
  assert.equal(approve?.action_id, "approve");
  assert.equal(approve?.value, PROPOSAL_ID);
  assert.equal(approve?.style, "primary");
  assert.equal(approve?.text.text, "Approve");
  assert.equal(reject?.action_id, "reject");
  assert.equal(reject?.value, PROPOSAL_ID);
  assert.equal(reject?.style, "danger");
});

test("long note payload is truncated to the preview cap with the after-approval note", () => {
  const { blocks } = weeklyPrompt();
  const preview = sectionTexts(blocks)[1] ?? "";
  assert.ok(preview.startsWith("Lil Bull Weekly Market Brief — week of 2026-08-24"));
  assert.ok(preview.endsWith("…"), "truncated preview must end with an ellipsis");
  // Cap is applied before mrkdwn escaping, so allow for entity growth.
  assert.ok(preview.length <= 700, `preview too long: ${preview.length}`);
  assert.ok(preview.includes("S&amp;P 500"), "preview must be mrkdwn-escaped");
  const note = blocks.find((b) => b.type === "context");
  assert.ok(
    note?.type === "context" && note.elements[0]?.text === "Full text lands in the OS after approval.",
  );
});

test("short note payload is not truncated and gets no ellipsis", () => {
  const { blocks } = buildApprovalPrompt({
    proposalId: PROPOSAL_ID,
    ventureName: "Lil Bull",
    action: "note.append",
    proposedBy: "claude-slack",
    createdAt: CREATED_AT,
    payload: { text: "Logged the vendor call outcome." },
  });
  assert.equal(sectionTexts(blocks)[1], "Logged the vendor call outcome.");
});

test("ledger.add renders dollars from integer cents, compact fields, no JSON", () => {
  const { blocks } = buildApprovalPrompt({
    proposalId: PROPOSAL_ID,
    ventureName: "Lil Bull",
    action: "ledger.add",
    proposedBy: "claude-slack",
    createdAt: CREATED_AT,
    payload: { amount_cents: 50000, category: "sale", counterparty: "Acme & Co", item: "Consulting" },
  });
  const preview = sectionTexts(blocks)[1] ?? "";
  assert.ok(preview.includes("*Amount:* +$500.00"));
  assert.ok(preview.includes("*Category:* sale"));
  assert.ok(preview.includes("Acme &amp; Co"));
  assert.ok(!preview.includes("{"), "no raw JSON in previews");

  const negative = buildApprovalPrompt({
    proposalId: PROPOSAL_ID,
    ventureName: "Lil Bull",
    action: "ledger.add",
    proposedBy: "claude-slack",
    createdAt: CREATED_AT,
    payload: { amount_cents: -1234 },
  });
  assert.ok((sectionTexts(negative.blocks)[1] ?? "").includes("*Amount:* -$12.34"));
});

test("ticket.add renders subject and present fields only", () => {
  const { blocks } = buildApprovalPrompt({
    proposalId: PROPOSAL_ID,
    ventureName: "Lil Bull",
    action: "ticket.add",
    proposedBy: "claude-slack",
    createdAt: CREATED_AT,
    payload: { subject: "Refund request", channel: "IG DM" },
  });
  const preview = sectionTexts(blocks)[1] ?? "";
  assert.ok(preview.includes("*Subject:* Refund request"));
  assert.ok(preview.includes("*Channel:* IG DM"));
  assert.ok(!preview.includes("Customer"), "absent fields are omitted, not rendered empty");
});

test("unknown action falls back to compact field lines, capped, never raw JSON", () => {
  const payload: Record<string, unknown> = { kind: "mystery", detail: "x".repeat(500) };
  for (let i = 0; i < 10; i++) payload[`extra${i}`] = i;
  const { blocks } = buildApprovalPrompt({
    proposalId: PROPOSAL_ID,
    ventureName: "Lil Bull",
    action: "something.new",
    proposedBy: "future-bot",
    createdAt: CREATED_AT,
    payload,
  });
  const preview = sectionTexts(blocks)[1] ?? "";
  assert.ok(preview.includes("*kind:* mystery"));
  assert.ok(preview.includes("more field(s)"), "field count must be capped with a remainder note");
  for (const line of preview.split("\n")) assert.ok(line.length <= 160, "field values must be truncated");
});

test("empty payload warns instead of rendering nothing, buttons still present", () => {
  const { blocks } = buildApprovalPrompt({
    proposalId: PROPOSAL_ID,
    ventureName: "Lil Bull",
    action: "note.append",
    proposedBy: "weekly-insight",
    createdAt: CREATED_AT,
    payload: {},
  });
  assert.ok(sectionTexts(blocks).some((t) => t.startsWith("⚠️")));
  assert.equal(buttons(blocks).length, 2, "reject must stay possible for broken payloads");
});

test("decided message keeps venture, action, source, and time — and has no buttons", () => {
  const { text, blocks } = buildDecidedMessage({
    decision: "approve",
    ventureName: "Lil Bull",
    action: "note.append",
    proposedBy: "weekly-insight",
    decidedAt: new Date("2026-08-24T14:30:00Z"),
    via: "by Justin",
  });
  assert.equal(sectionTexts(blocks)[0], "✅ *Approved by Justin* · 2026-08-24 14:30 UTC");
  const ctx = blocks.find((b) => b.type === "context");
  assert.equal(
    ctx?.type === "context" ? ctx.elements[0]?.text : "",
    "Lil Bull · note.append · proposed by weekly-insight",
  );
  assert.equal(buttons(blocks).length, 0, "a decided message must never carry live buttons");
  assert.ok(text.includes("Approved") && text.includes("Lil Bull"));
});

test("disarm variant (no via) reads as a plain outcome", () => {
  const { blocks } = buildDecidedMessage({
    decision: "reject",
    ventureName: "Lil Bull",
    action: "ledger.add",
    proposedBy: "claude-slack",
    decidedAt: new Date("2026-08-24T15:00:00Z"),
  });
  assert.equal(sectionTexts(blocks)[0], "❌ *Rejected* · 2026-08-24 15:00 UTC");
});
