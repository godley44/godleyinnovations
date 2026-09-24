// Tests for the publish state machine: how per-target ledger rows roll up
// into the post's aggregate status, and how rows render as summary
// outcomes. The dry-run rules matter most — the whole pipeline must settle
// visibly WITHOUT a real key, yet never claim a dry run was published. Since
// migration 008 a target is (venture, platform), so a cross-published post
// aggregates over both ventures' rows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerKey } from "./content-publish.js";
import { aggregateCalendar, outcomeFromRow, type PublishLedgerRow } from "./social-publish.js";

const CT = "v-ct";
const KB = "v-kb";

function row(platform: string, status: PublishLedgerRow["status"], extra?: Partial<PublishLedgerRow>): PublishLedgerRow {
  return {
    calendar_id: "cal-1",
    venture_id: CT,
    platform,
    status,
    submission_id: null,
    public_url: null,
    error: null,
    ...extra,
  };
}

function ledger(...rows: PublishLedgerRow[]): Map<string, PublishLedgerRow> {
  return new Map(rows.map((r) => [ledgerKey(r.venture_id, r.platform), r]));
}

const TW_LI = [ledgerKey(CT, "twitter"), ledgerKey(CT, "linkedin")];

test("all published → 'published'; a mix of published and failed → 'partial'; all failed → 'failed'", () => {
  assert.deepEqual(aggregateCalendar(TW_LI, ledger(row("twitter", "published"), row("linkedin", "published"))), {
    complete: true,
    status: "published",
  });
  assert.deepEqual(aggregateCalendar(TW_LI, ledger(row("twitter", "published"), row("linkedin", "failed"))), {
    complete: true,
    status: "partial",
  });
  assert.deepEqual(aggregateCalendar(TW_LI, ledger(row("twitter", "failed"), row("linkedin", "failed"))), {
    complete: true,
    status: "failed",
  });
});

test("missing, publishing, or submitted rows keep the post incomplete", () => {
  assert.equal(aggregateCalendar(TW_LI, ledger(row("twitter", "published"))).complete, false);
  assert.equal(aggregateCalendar([ledgerKey(CT, "twitter")], ledger(row("twitter", "publishing"))).complete, false);
  assert.equal(aggregateCalendar([ledgerKey(CT, "twitter")], ledger(row("twitter", "submitted"))).complete, false);
  assert.equal(aggregateCalendar([], ledger()).complete, false, "a targetless post can never settle as published");
});

test("dry-run rows settle the post for now but never mark it published — status stays null", () => {
  const allDry = aggregateCalendar(TW_LI, ledger(row("twitter", "dry-run"), row("linkedin", "dry-run")));
  assert.deepEqual(allDry, { complete: true, status: null });
  // Even one leftover dry-run row (e.g. after the real key re-armed only one
  // platform) keeps the aggregate honest.
  const mixed = aggregateCalendar(TW_LI, ledger(row("twitter", "published"), row("linkedin", "dry-run")));
  assert.deepEqual(mixed, { complete: true, status: null });
});

test("a cross-published post aggregates over every (venture, platform) target — one venture's row never stands in for another's", () => {
  const targets = [ledgerKey(CT, "instagram"), ledgerKey(CT, "facebook"), ledgerKey(KB, "instagram"), ledgerKey(KB, "facebook")];
  const ctOnly = ledger(row("instagram", "published"), row("facebook", "published"));
  assert.equal(aggregateCalendar(targets, ctOnly).complete, false, "KBOS rows missing → still in flight");

  const both = ledger(
    row("instagram", "published"),
    row("facebook", "published"),
    row("instagram", "published", { venture_id: KB }),
    row("facebook", "failed", { venture_id: KB, error: "page id missing" }),
  );
  assert.deepEqual(aggregateCalendar(targets, both), { complete: true, status: "partial" });
});

test("outcomes map ledger rows to summary lines, naming the venture when known; a stuck 'publishing' row is never summarized", () => {
  assert.deepEqual(outcomeFromRow(row("twitter", "published", { public_url: "https://x.com/p/1" })), {
    platform: "twitter",
    status: "published",
    publicUrl: "https://x.com/p/1",
  });
  assert.deepEqual(outcomeFromRow(row("twitter", "published")), { platform: "twitter", status: "published" });
  assert.deepEqual(outcomeFromRow(row("linkedin", "submitted")), { platform: "linkedin", status: "submitted" });
  assert.deepEqual(outcomeFromRow(row("twitter", "dry-run")), { platform: "twitter", status: "dry-run" });
  assert.deepEqual(outcomeFromRow(row("linkedin", "failed", { error: "media rejected" })), {
    platform: "linkedin",
    status: "failed",
    detail: "media rejected",
  });
  assert.deepEqual(outcomeFromRow(row("instagram", "dry-run", { venture_id: KB, venture_name: "Kingdom Building OS" })), {
    platform: "instagram",
    status: "dry-run",
    ventureName: "Kingdom Building OS",
  });
  assert.equal(outcomeFromRow(row("twitter", "publishing")), null);
});
