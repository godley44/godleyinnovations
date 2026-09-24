// Pure state logic for the social publishing pipeline: how a post's
// per-target ledger rows (social_publishes, migrations 007 + 009) roll up
// into the content_calendar aggregate status, and how a ledger row renders
// as a summary-line outcome. Kept free of I/O so the state machine is
// unit-testable; the poller owns all database and Blotato calls.
//
// A TARGET is a (venture, platform) pair — since migration 009 a post may
// publish to more than one venture (venture_cross_publish), each through
// its own key and accounts, so the ledger is keyed by venture_id:platform
// (content-publish.ts → ledgerKey). A single-venture text post simply has
// one venture in every key — the old behavior, unchanged.
//
// Ledger row lifecycle per (post, venture, platform):
//   publishing → submitted → published | failed        (real key)
//   publishing → dry-run                               (no real key for that venture)
//   publishing → failed                                (refused before/at POST)
// 'failed' is terminal — Blotato's docs say "do not retry on failed" —
// delete the row to re-arm that one target after fixing the cause.
// 'dry-run' is terminal for the ledger but NOT for the post: the calendar
// row stays 'publishing' so that, once the real key exists, deleting the
// dry-run rows re-arms the real publish with zero other changes.

import type { PlatformOutcome } from "./social-blocks.js";

export type PublishLedgerStatus = "publishing" | "submitted" | "published" | "failed" | "dry-run";

export interface PublishLedgerRow {
  calendar_id: string;
  venture_id: string;
  venture_name?: string; // for the summary line; absent on legacy fixtures
  platform: string;
  status: PublishLedgerStatus;
  submission_id: string | null;
  public_url: string | null;
  error: string | null;
}

export interface CalendarAggregate {
  // Every target has a ledger row and none is still in flight
  // (publishing/submitted).
  complete: boolean;
  // The content_calendar status to record when complete — null means "stay
  // 'publishing'": dry-run rows are present, so the post is settled for now
  // but not actually published until the real key exists and re-arms it.
  status: "published" | "partial" | "failed" | null;
}

// `targets` are ledger keys (ventureId:platform); `rows` is keyed the same
// way.
export function aggregateCalendar(targets: string[], rows: Map<string, PublishLedgerRow>): CalendarAggregate {
  if (targets.length === 0) return { complete: false, status: null };
  let published = 0;
  let failed = 0;
  let dryRun = 0;
  for (const target of targets) {
    const row = rows.get(target);
    if (!row || row.status === "publishing" || row.status === "submitted") {
      return { complete: false, status: null };
    }
    if (row.status === "published") published += 1;
    else if (row.status === "failed") failed += 1;
    else dryRun += 1;
  }
  if (dryRun > 0) return { complete: true, status: null };
  if (failed === 0) return { complete: true, status: "published" };
  if (published === 0) return { complete: true, status: "failed" };
  return { complete: true, status: "partial" };
}

// null for a 'publishing' row: stuck or in-flight — surfaced as needing
// attention by the poller, never rendered into a summary line.
export function outcomeFromRow(row: PublishLedgerRow): PlatformOutcome | null {
  const venture = row.venture_name !== undefined ? { ventureName: row.venture_name } : {};
  switch (row.status) {
    case "published":
      return row.public_url
        ? { platform: row.platform, status: "published", publicUrl: row.public_url, ...venture }
        : { platform: row.platform, status: "published", ...venture };
    case "submitted":
      return { platform: row.platform, status: "submitted", ...venture };
    case "dry-run":
      return { platform: row.platform, status: "dry-run", ...venture };
    case "failed":
      return { platform: row.platform, status: "failed", detail: row.error ?? "no reason recorded", ...venture };
    case "publishing":
      return null;
  }
}
