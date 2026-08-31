// Pure state logic for the social publishing pipeline: how a post's
// per-platform ledger rows (social_publishes, migration 007) roll up into
// the content_calendar aggregate status, and how a ledger row renders as a
// summary-line outcome. Kept free of I/O so the state machine is
// unit-testable; the poller owns all database and Blotato calls.
//
// Ledger row lifecycle per (post, platform):
//   publishing → submitted → published | failed        (real key)
//   publishing → dry-run                               (placeholder key)
//   publishing → failed                                (refused before/at POST)
// 'failed' is terminal — Blotato's docs say "do not retry on failed" —
// delete the row to re-arm that one platform after fixing the cause.
// 'dry-run' is terminal for the ledger but NOT for the post: the calendar
// row stays 'publishing' so that, once the real key exists, deleting the
// dry-run rows re-arms the real publish with zero other changes.

import type { PlatformOutcome } from "./social-blocks.js";

export type PublishLedgerStatus = "publishing" | "submitted" | "published" | "failed" | "dry-run";

export interface PublishLedgerRow {
  calendar_id: string;
  platform: string;
  status: PublishLedgerStatus;
  submission_id: string | null;
  public_url: string | null;
  error: string | null;
}

export interface CalendarAggregate {
  // Every platform has a ledger row and none is still in flight
  // (publishing/submitted).
  complete: boolean;
  // The content_calendar status to record when complete — null means "stay
  // 'publishing'": dry-run rows are present, so the post is settled for now
  // but not actually published until the real key exists and re-arms it.
  status: "published" | "partial" | "failed" | null;
}

export function aggregateCalendar(platforms: string[], rows: Map<string, PublishLedgerRow>): CalendarAggregate {
  if (platforms.length === 0) return { complete: false, status: null };
  let published = 0;
  let failed = 0;
  let dryRun = 0;
  for (const platform of platforms) {
    const row = rows.get(platform);
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
  switch (row.status) {
    case "published":
      return row.public_url
        ? { platform: row.platform, status: "published", publicUrl: row.public_url }
        : { platform: row.platform, status: "published" };
    case "submitted":
      return { platform: row.platform, status: "submitted" };
    case "dry-run":
      return { platform: row.platform, status: "dry-run" };
    case "failed":
      return { platform: row.platform, status: "failed", detail: row.error ?? "no reason recorded" };
    case "publishing":
      return null;
  }
}
