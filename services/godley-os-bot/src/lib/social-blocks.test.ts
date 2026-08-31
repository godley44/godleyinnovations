// Tests for the publish-summary rendering: one line per platform, partial
// failures never hide the successes, dry runs are explicit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPublishSummary } from "./social-blocks.js";
import type { SlackBlock } from "./brief-blocks.js";

const AT = new Date("2026-08-25T14:00:00Z");

function sectionTexts(blocks: SlackBlock[]): string[] {
  return blocks.filter((b) => b.type === "section").map((b) => b.text.text);
}

function headerText(blocks: SlackBlock[]): string {
  const h = blocks[0];
  return h?.type === "header" ? h.text.text : "";
}

test("all published: Published header, one ✅ line per platform, link when known", () => {
  const { text, blocks } = buildPublishSummary({
    ventureName: "Lil Bull",
    postText: "Fresh weekly setup is out.",
    outcomes: [
      { platform: "twitter", status: "published", publicUrl: "https://x.com/lilbull/status/1" },
      { platform: "linkedin", status: "published" },
    ],
    publishedAt: AT,
  });
  assert.equal(headerText(blocks), "Published — Lil Bull");
  const lines = sectionTexts(blocks)[0] ?? "";
  assert.ok(lines.includes("✅ *X/Twitter* — published (<https://x.com/lilbull/status/1|view post>)"));
  assert.ok(lines.includes("✅ *LinkedIn* — published"));
  assert.equal(text, "Published — Lil Bull");
});

test("partial failure: issues header, the failed line carries its reason, successes stay visible", () => {
  const { blocks } = buildPublishSummary({
    ventureName: "Lil Bull",
    postText: "post",
    outcomes: [
      { platform: "twitter", status: "published", publicUrl: "https://x.com/p/1" },
      { platform: "youtube", status: "failed", detail: "media rejected & unsupported" },
      { platform: "linkedin", status: "submitted" },
    ],
    publishedAt: AT,
  });
  assert.equal(headerText(blocks), "Publish issues — Lil Bull");
  const lines = sectionTexts(blocks)[0] ?? "";
  assert.ok(lines.includes("❌ *YouTube* — failed: media rejected &amp; unsupported"), "reason present, escaped");
  assert.ok(lines.includes("✅ *X/Twitter* — published"), "one failure must not hide the successes");
  assert.ok(lines.includes("📤 *LinkedIn* — submitted, confirmation pending"));
});

test("all dry-run: explicit dry-run header and per-line explanation", () => {
  const { blocks } = buildPublishSummary({
    ventureName: "Lil Bull",
    postText: "post",
    outcomes: [
      { platform: "twitter", status: "dry-run" },
      { platform: "linkedin", status: "dry-run" },
    ],
    publishedAt: AT,
  });
  assert.equal(headerText(blocks), "Publish dry run — Lil Bull");
  const lines = sectionTexts(blocks)[0] ?? "";
  assert.equal((lines.match(/🧪/g) ?? []).length, 2);
  assert.ok(lines.includes("no real key; request logged, nothing sent"));
});

test("post text preview is truncated and escaped; footer carries the OS stamp", () => {
  const { blocks } = buildPublishSummary({
    ventureName: "Lil Bull",
    postText: `S&P setup: ${"x".repeat(400)}`,
    outcomes: [{ platform: "twitter", status: "published" }],
    publishedAt: AT,
  });
  const contexts = blocks.filter((b) => b.type === "context");
  const preview = contexts[0]?.elements[0]?.text ?? "";
  assert.ok(preview.startsWith("S&amp;P setup:"), "preview escaped");
  assert.ok(preview.length <= 300, "preview truncated");
  assert.ok(preview.endsWith("…"));
  assert.equal(contexts[1]?.elements[0]?.text, "2026-08-25 14:00 UTC · Godley Innovations OS");
});
