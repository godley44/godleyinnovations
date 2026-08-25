// Unit tests for the WhatsApp hand-off rendering: the delivery message
// (code block for one-tap copy) and its header/footer contract.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWhatsAppDelivery } from "./whatsapp-blocks.js";
import { buildApprovalPrompt } from "./approval-blocks.js";
import type { SlackBlock } from "./brief-blocks.js";

// Shaped like the owner-approved WhatsApp template the framing agent targets.
const FRAMED = [
  "🐂 LIL BULL — WEEKLY MARKET BRIEF",
  "📅 Week of 2026-08-24",
  "Market Outlook",
  "🟢 S&P 500: Bullish",
  "🟡 SNDK: Neutral",
  "🔴 INTEL: Bearish",
  "⚖️ Weekly Lean: LONG — Medium Conviction",
  "Trend intact on the index while the chip names diverge; patience beats chasing.",
  "Key Levels",
  "- S&P 500: 7652.86",
  "- SNDK: $1493.12",
  "- INTEL: $84.20",
  "📆 What Matters This Week",
  "- Wed: FOMC minutes",
  "- Thu: INTC guidance update",
  "Bottom Line: The index holding its daily trend confirms the long lean; a close under the INTEL level invalidates its setup.",
  "Analysis only — not financial advice. Trade your own plan.",
].join("\n");

function build() {
  return buildWhatsAppDelivery({
    framedText: FRAMED,
    ventureName: "Lil Bull",
    generatedAt: new Date("2026-08-25T14:00:00Z"),
  });
}

function sectionTexts(blocks: SlackBlock[]): string[] {
  return blocks.filter((b) => b.type === "section").map((b) => b.text.text);
}

test("delivery: one-line header + framed text in a code block", () => {
  const { blocks, text } = build();
  const header = blocks[0];
  assert.equal(header?.type, "header");
  assert.equal(header?.type === "header" ? header.text.text : "", "WhatsApp message ready — Lil Bull");
  const body = sectionTexts(blocks)[0] ?? "";
  assert.ok(body.startsWith("```\n"), "framed text must sit in a code block for one-tap copy");
  assert.ok(body.endsWith("\n```"));
  assert.ok(body.includes("🟡 SNDK: Neutral"), "template stance lines survive intact");
  assert.ok(body.includes("🟢 S&amp;P 500: Bullish"), "entities escaped inside the block");
  assert.ok(body.includes("Analysis only — not financial advice. Trade your own plan."));
  assert.equal(text, "WhatsApp message ready — Lil Bull");
});

test("delivery: copy hint and OS footer are context blocks", () => {
  const contexts = build().blocks.filter((b) => b.type === "context");
  assert.equal(contexts.length, 2);
  assert.match(contexts[0]?.elements[0]?.text ?? "", /paste into the WhatsApp group/);
  assert.equal(contexts[1]?.elements[0]?.text, "Generated 2026-08-25 14:00 UTC · Godley Innovations OS");
});

test("delivery: backticks in the framed text cannot break the code fence; entities escaped", () => {
  const { blocks } = buildWhatsAppDelivery({
    framedText: "watch `SNDK` & the ``` fence",
    ventureName: "Lil Bull",
    generatedAt: new Date("2026-08-25T14:00:00Z"),
  });
  const body = sectionTexts(blocks)[0] ?? "";
  assert.equal((body.match(/```/g) ?? []).length, 2, "exactly the opening and closing fence");
  assert.ok(body.includes("&amp;"), "mrkdwn entities must be escaped inside the fence");
});

test("delivery: no buttons anywhere — this message is a hand-off, not a prompt", () => {
  assert.ok(build().blocks.every((b) => b.type !== "actions"));
});

test("approval preview for whatsapp.message shows the full text in a code block", () => {
  const { blocks } = buildApprovalPrompt({
    proposalId: "3d0f8a9e-1111-2222-3333-444455556666",
    ventureName: "Lil Bull",
    action: "whatsapp.message",
    proposedBy: "framing-agent",
    createdAt: new Date("2026-08-25T14:00:00Z"),
    payload: { text: FRAMED, source_proposal_id: "aaaabbbb-1111-2222-3333-444455556666" },
  });
  const preview = sectionTexts(blocks).find((t) => t.startsWith("```"));
  assert.ok(preview, "whatsapp.message preview must be a code block");
  assert.ok(
    preview.includes("Analysis only — not financial advice. Trade your own plan."),
    "the FULL framed text must be visible",
  );
  const note = blocks.find((b) => b.type === "context");
  assert.match(note?.type === "context" ? (note.elements[0]?.text ?? "") : "", /This exact text is what gets handed over/);
  const actions = blocks.find((b) => b.type === "actions");
  assert.ok(actions?.type === "actions" && actions.elements.length === 2, "Approve/Reject buttons must be present");
});

test("approval preview truncates a pathologically long whatsapp.message with a note", () => {
  const { blocks } = buildApprovalPrompt({
    proposalId: "3d0f8a9e-1111-2222-3333-444455556666",
    ventureName: "Lil Bull",
    action: "whatsapp.message",
    proposedBy: "framing-agent",
    createdAt: new Date("2026-08-25T14:00:00Z"),
    payload: { text: "x".repeat(4000) },
  });
  const preview = sectionTexts(blocks).find((t) => t.startsWith("```")) ?? "";
  assert.ok(preview.length <= 3000, "Slack's section limit must hold");
  const note = blocks.find((b) => b.type === "context");
  assert.match(note?.type === "context" ? (note.elements[0]?.text ?? "") : "", /Preview truncated/);
});
