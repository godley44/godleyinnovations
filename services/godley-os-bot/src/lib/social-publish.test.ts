// Tests for the publish state machine: how per-platform ledger rows roll up
// into the post's aggregate status, and how rows render as summary
// outcomes. The dry-run rules matter most — the whole pipeline must settle
// visibly WITHOUT a real key, yet never claim a dry run was published.

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateCalendar, outcomeFromRow, type PublishLedgerRow } from "./social-publish.js";

function row(platform: string, status: PublishLedgerRow["status"], extra?: Partial<PublishLedgerRow>): PublishLedgerRow {
  return {
    calendar_id: "cal-1",
    platform,
    status,
    submission_id: null,
    public_url: null,
    error: null,
    ...extra,
  };
}

function ledger(...rows: PublishLedgerRow[]): Map<string, PublishLedgerRow> {
  return new Map(rows.map((r) => [r.platform, r]));
}

test("all published → 'published'; a mix of published and failed → 'partial'; all failed → 'failed'", () => {
  assert.deepEqual(aggregateCalendar(["twitter", "linkedin"], ledger(row("twitter", "published"), row("linkedin", "published"))), {
    complete: true,
    status: "published",
  });
  assert.deepEqual(aggregateCalendar(["twitter", "linkedin"], ledger(row("twitter", "published"), row("linkedin", "failed"))), {
    complete: true,
    status: "partial",
  });
  assert.deepEqual(aggregateCalendar(["twitter", "linkedin"], ledger(row("twitter", "failed"), row("linkedin", "failed"))), {
    complete: true,
    status: "failed",
  });
});

test("missing, publishing, or submitted rows keep the post incomplete", () => {
  assert.equal(aggregateCalendar(["twitter", "linkedin"], ledger(row("twitter", "published"))).complete, false);
  assert.equal(aggregateCalendar(["twitter"], ledger(row("twitter", "publishing"))).complete, false);
  assert.equal(aggregateCalendar(["twitter"], ledger(row("twitter", "submitted"))).complete, false);
  assert.equal(aggregateCalendar([], ledger()).complete, false, "a platformless post can never settle as published");
});

test("dry-run rows settle the post for now but never mark it published — status stays null", () => {
  const allDry = aggregateCalendar(["twitter", "linkedin"], ledger(row("twitter", "dry-run"), row("linkedin", "dry-run")));
  assert.deepEqual(allDry, { complete: true, status: null });
  // Even one leftover dry-run row (e.g. after the real key re-armed only one
  // platform) keeps the aggregate honest.
  const mixed = aggregateCalendar(["twitter", "linkedin"], ledger(row("twitter", "published"), row("linkedin", "dry-run")));
  assert.deepEqual(mixed, { complete: true, status: null });
});

test("outcomes map ledger rows to summary lines; a stuck 'publishing' row is never summarized", () => {
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
  assert.equal(outcomeFromRow(row("twitter", "publishing")), null);
});
