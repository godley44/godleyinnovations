// The video pipeline's pure rules: the TUNE ME prompt's non-negotiables,
// draft validation (before anything is spent), the model-output checks, and
// the exact video.script proposal shape.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkScript,
  readVideoScriptPayload,
  SCRIPT_MAX_WORDS,
  SCRIPT_MIN_WORDS,
  TITLE_MAX_CHARS,
  validateVideoDraft,
  VIDEO_SCRIPT_SYSTEM_PROMPT,
  videoScriptProposalRow,
} from "./video-script.js";

const STACK = [
  { platform: "twitter", enabled: true },
  { platform: "linkedin", enabled: true },
  { platform: "youtube", enabled: true },
  { platform: "instagram", enabled: false },
];
const CTA = "Follow Lil Bull for next week's brief.";
const GOOD_SCRIPT =
  "Here is the one thing to watch this week: the market is leaning cautious. " +
  "The brief keeps every level where it was and says nothing new about the calendar. " +
  "That means patience beats prediction for now, and the setup matters more than the headline. " +
  "If the range holds, the plan does not change. If it breaks, we will talk about it next week. " +
  "That is the whole idea, and it is enough for a week like this one, so keep it simple. " +
  CTA;

test("prompt carries the non-negotiables: length band, one takeaway, no invented numbers, spoken-only, CTA last", () => {
  assert.match(VIDEO_SCRIPT_SYSTEM_PROMPT, /45 to 90 seconds/);
  assert.match(VIDEO_SCRIPT_SYSTEM_PROMPT, /ONE takeaway/);
  assert.match(VIDEO_SCRIPT_SYSTEM_PROMPT, /NEVER state a market number or fact that is not present/);
  assert.match(VIDEO_SCRIPT_SYSTEM_PROMPT, /no emojis/);
  assert.match(VIDEO_SCRIPT_SYSTEM_PROMPT, /CALL TO ACTION[\s\S]*verbatim/);
});

test("validateVideoDraft: happy path with sourceText", () => {
  const r = validateVideoDraft({ title: " Weekly brief ", sourceText: " text ", platforms: ["youtube", "youtube"] }, STACK);
  assert.ok(r.ok);
  assert.deepEqual(r.draft, { title: "Weekly brief", platforms: ["youtube"], sourceText: "text", calendarId: null });
});

test("validateVideoDraft: refusals — title, source, both sources, bad uuid, text platforms, disabled instagram", () => {
  const err = (body: unknown) => {
    const r = validateVideoDraft(body, STACK);
    assert.ok(!r.ok);
    return r.error;
  };
  assert.match(err({ sourceText: "t", platforms: ["youtube"] }), /title is required/);
  assert.match(err({ title: "x".repeat(TITLE_MAX_CHARS + 1), sourceText: "t", platforms: ["youtube"] }), /longer than/);
  assert.match(err({ title: "t", platforms: ["youtube"] }), /sourceText .* or calendarId/);
  assert.match(err({ title: "t", sourceText: "a", calendarId: "11111111-1111-4111-8111-111111111111", platforms: ["youtube"] }), /not both/);
  assert.match(err({ title: "t", calendarId: "nope", platforms: ["youtube"] }), /uuid/);
  assert.match(err({ title: "t", sourceText: "a", platforms: ["twitter"] }), /youtube\/instagram only/);
  assert.match(err({ title: "t", sourceText: "a", platforms: ["instagram"] }), /not in this venture's enabled platform stack: instagram/);
  assert.match(err({ title: "t", sourceText: "a", platforms: [] }), /platforms is required/);
});

test("checkScript: accepts a clean spoken script ending on the CTA; strips code fences", () => {
  const r = checkScript("```\n" + GOOD_SCRIPT + "\n```", CTA);
  assert.ok(r.ok);
  assert.equal(r.script, GOOD_SCRIPT);
});

test("checkScript: refuses empty, too short, too long, missing CTA, list markers / emojis", () => {
  const fail = (raw: string) => {
    const r = checkScript(raw, CTA);
    assert.ok(!r.ok);
    return r.error;
  };
  assert.match(fail(""), /empty/);
  assert.match(fail("too short. " + CTA), new RegExp(`under the ${SCRIPT_MIN_WORDS}`));
  assert.match(fail("word ".repeat(SCRIPT_MAX_WORDS + 1) + CTA), new RegExp(`over the ${SCRIPT_MAX_WORDS}`));
  assert.match(fail(GOOD_SCRIPT.replace(CTA, "Thanks for watching.")), /does not end with the venture's call to action/);
  assert.match(fail("- " + GOOD_SCRIPT), /list markers/);
  assert.match(fail(GOOD_SCRIPT.replace("Here is", "🐂 Here is")), /emojis/);
});

test("videoScriptProposalRow: exact video.script proposal shape, source preview capped", () => {
  const row = videoScriptProposalRow({
    ventureId: "v-1",
    script: "script",
    title: "Title",
    platforms: ["youtube"],
    cta: CTA,
    sourceCalendarId: null,
    sourceText: "s".repeat(500),
  });
  assert.equal(row.action, "video.script");
  assert.equal(row.proposed_by, "video-agent");
  assert.equal(row.venture_id, "v-1");
  assert.equal(row.payload.script, "script");
  assert.equal(row.payload.title, "Title");
  assert.deepEqual(row.payload.platforms, ["youtube"]);
  assert.equal(row.payload.cta, CTA);
  assert.equal(row.payload.source_calendar_id, null);
  assert.equal(row.payload.source_preview.length, 200);
  assert.ok(row.payload.source_preview.endsWith("…"));
});

test("readVideoScriptPayload: round-trips the row and rejects unusable payloads", () => {
  const row = videoScriptProposalRow({ ventureId: "v", script: "s", title: "t", platforms: ["youtube"], cta: CTA, sourceCalendarId: "c", sourceText: "x" });
  const back = readVideoScriptPayload(JSON.parse(JSON.stringify(row.payload)));
  assert.deepEqual(back, row.payload);
  assert.equal(readVideoScriptPayload({ script: "s", title: "t", platforms: [] }), null);
  assert.equal(readVideoScriptPayload({ title: "t", platforms: ["youtube"] }), null);
  assert.equal(readVideoScriptPayload(null), null);
});
