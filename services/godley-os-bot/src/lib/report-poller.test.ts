// The framed-proposal payload shape is a contract: the prompts step, the
// delivery step, and the approval preview all key off these exact fields.

import assert from "node:assert/strict";
import { test } from "node:test";
import { framedProposalRow } from "./report-poller.js";

test("framedProposalRow: exact whatsapp.message proposal shape", () => {
  const row = framedProposalRow(
    { id: "aaaabbbb-1111-2222-3333-444455556666", venture_id: "ccccdddd-1111-2222-3333-444455556666" },
    "framed text",
  );
  assert.deepEqual(row, {
    venture_id: "ccccdddd-1111-2222-3333-444455556666",
    action: "whatsapp.message",
    proposed_by: "framing-agent",
    payload: { text: "framed text", source_proposal_id: "aaaabbbb-1111-2222-3333-444455556666" },
  });
});

test("framedProposalRow: the venture comes from the source proposal, never elsewhere", () => {
  const row = framedProposalRow({ id: "src", venture_id: "the-source-venture" }, "text");
  assert.equal(row.venture_id, "the-source-venture");
  assert.equal(row.payload.source_proposal_id, "src");
});
