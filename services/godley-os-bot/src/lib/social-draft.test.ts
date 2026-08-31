// Tests for the /admin/social-draft validation rules and the social.post
// proposal row shape — the venture-isolation and no-youtube-this-phase
// gates live here, before anything touches the database.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  socialProposalRow,
  validateSocialDraft,
  type DraftValidation,
  type SocialDraft,
  type VenturePlatformRow,
} from "./social-draft.js";

const STACK: VenturePlatformRow[] = [
  { platform: "twitter", blotato_account_id: null, blotato_page_id: null, youtube_privacy: null, enabled: true },
  { platform: "linkedin", blotato_account_id: null, blotato_page_id: null, youtube_privacy: null, enabled: true },
  { platform: "youtube", blotato_account_id: null, blotato_page_id: null, youtube_privacy: "public", enabled: true },
  { platform: "tiktok", blotato_account_id: null, blotato_page_id: null, youtube_privacy: null, enabled: false },
];

function expectDraft(v: DraftValidation): SocialDraft {
  if (!v.ok) throw new Error(`expected a valid draft, got: ${v.error}`);
  return v.draft;
}

function expectError(v: DraftValidation): string {
  if (v.ok) throw new Error("expected a validation error, got a valid draft");
  return v.error;
}

test("a good draft passes, dedupes platforms, trims text", () => {
  const draft = expectDraft(
    validateSocialDraft({ text: "  Fresh setup is live.  ", platforms: ["twitter", "linkedin", "twitter"] }, STACK),
  );
  assert.deepEqual(draft, {
    text: "Fresh setup is live.",
    platforms: ["twitter", "linkedin"],
    mediaUrls: [],
    scheduledFor: null,
  });
});

test("youtube is refused this phase even though it is in the stack", () => {
  const error = expectError(validateSocialDraft({ text: "post", platforms: ["twitter", "youtube"] }, STACK));
  assert.match(error, /youtube needs a per-post video and title/);
});

test("platforms outside the venture's enabled stack are refused — posts never cross ventures", () => {
  const outside = expectError(validateSocialDraft({ text: "post", platforms: ["bluesky"] }, STACK));
  assert.match(outside, /not in this venture's enabled platform stack: bluesky/);

  const disabled = expectError(validateSocialDraft({ text: "post", platforms: ["tiktok"] }, STACK));
  assert.match(disabled, /tiktok/);
});

test("empty text and empty platforms are refused", () => {
  assert.match(expectError(validateSocialDraft({ text: "   ", platforms: ["twitter"] }, STACK)), /text is required/);
  assert.match(expectError(validateSocialDraft({ text: "post", platforms: [] }, STACK)), /platforms is required/);
});

test("media URLs must be http(s); scheduledFor must parse and is normalized to ISO", () => {
  const badUrl = expectError(
    validateSocialDraft({ text: "post", platforms: ["twitter"], mediaUrls: ["ftp://nope/file.png"] }, STACK),
  );
  assert.match(badUrl, /publicly accessible http\(s\) URL/);

  const badTime = expectError(
    validateSocialDraft({ text: "post", platforms: ["twitter"], scheduledFor: "next tuesday" }, STACK),
  );
  assert.match(badTime, /informational only this phase/);

  const good = expectDraft(
    validateSocialDraft(
      {
        text: "post",
        platforms: ["twitter"],
        mediaUrls: ["https://example.com/chart.png"],
        scheduledFor: "2026-09-01T12:00:00Z",
      },
      STACK,
    ),
  );
  assert.deepEqual(good.mediaUrls, ["https://example.com/chart.png"]);
  assert.equal(good.scheduledFor, "2026-09-01T12:00:00.000Z");
});

test("the proposal row matches the rails contract: action, proposed_by, calendar_id in the payload", () => {
  const row = socialProposalRow({
    ventureId: "venture-1",
    calendarId: "cal-1",
    text: "Fresh setup is live.",
    platforms: ["twitter", "linkedin"],
  });
  assert.deepEqual(row, {
    venture_id: "venture-1",
    action: "social.post",
    proposed_by: "admin",
    payload: { calendar_id: "cal-1", text: "Fresh setup is live.", platforms: ["twitter", "linkedin"] },
  });
});
