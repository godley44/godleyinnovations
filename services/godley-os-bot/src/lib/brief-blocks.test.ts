// Unit tests for the Block Kit brief builder, against fixtures shaped
// exactly like supabase/functions/weekly-insight assembles the brief
// (sections joined by blank lines; table cells in renderFrame's format;
// legend and disclaimer verbatim). If the brief's assembly changes shape,
// these fixtures are where the contract is re-encoded.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBriefMessage, formatUtc, type SlackBlock } from "./brief-blocks.js";

const LEGEND =
  "Legend — MA pairs: 1H/1D/1W EMA9/21 on hourly/daily/weekly candles; 1M SMA50/200 monthly; 3M SMA50/200 quarterly; 1Y SMA50/200 on daily candles (golden-cross basis). MACD 12/26/9: +/- histogram sign, arrow rising/falling. SRSI: StochRSI 14-14-3-3 %K, ob/os over/oversold. (Nb) bars since MA cross. Data: Yahoo Finance candles; indicators computed, not estimated.";

const DISCLAIMER = "Analysis, not financial advice — trade your own plan.";

const FULL_BRIEF = [
  "Lil Bull Weekly Market Brief — week of 2026-08-17",
  [
    "S&P 500: Bullish - key level 7652.86 (daily SMA50)",
    "SNDK: Neutral - key level $1493.12 (latest close)",
    "INTEL: Bearish - key level $84.20 (20-session low)",
  ].join("\n"),
  "SNDK: data unavailable this week (feed error).",
  [
    "Timeframes:",
    "S&P 500: 1H MA↑(3b) MACD+↑ SRSI 62 | 1D +1.2% MA↑(21b) MACD+↑ SRSI 71ob | 1W +2.4% MA↑(8b) MACD+↑ SRSI 55",
    "  1M +3.1% MA↑(since 2023-11-30) | 3M +8.2% MA↑(since 2024-02-29) | 1Y +14.9% MA↑(since 2023-12-01)",
    "INTEL: 1H MA↓(2b) MACD-↓ SRSI 34 | 1D +0.4% MA↑(12b) MACD+↓ SRSI 48 | 1W +1.9% MA↑(6b) MACD+↑ SRSI 51",
    "  1M +2.7% MA↑(since 2023-12-29) | 3M MA n/a | 1Y +18.2% MA↑(since 2023-11-28)",
  ].join("\n"),
  ["This week:", "- Wed: FOMC minutes", "- Thu: initial jobless claims", "- Fri: Powell speaks at Jackson Hole"].join(
    "\n",
  ),
  "Sentiment: Broad risk appetite held up through options expiry. Flows into S&P 500 trackers stayed positive while breadth narrowed.",
  "Week lean: Long - Medium conviction - trend aligned across frames",
  LEGEND,
  DISCLAIMER,
].join("\n\n");

const GENERATED_AT = new Date("2026-08-17T13:05:00Z");

function build(briefText = FULL_BRIEF) {
  return buildBriefMessage({ briefText, ventureName: "Lil Bull", generatedAt: GENERATED_AT });
}

function sectionTexts(blocks: SlackBlock[]): string[] {
  return blocks.filter((b) => b.type === "section").map((b) => b.text.text);
}

function contextTexts(blocks: SlackBlock[]): string[] {
  return blocks.filter((b) => b.type === "context").map((b) => b.elements.map((e) => e.text).join(" "));
}

test("header block leads with the report title", () => {
  const { blocks } = build();
  const first = blocks[0];
  assert.equal(first?.type, "header");
  assert.equal(
    first?.type === "header" ? first.text.text : "",
    "Lil Bull Weekly Market Brief — week of 2026-08-17",
  );
});

test("venture name appears right under the header", () => {
  const { blocks } = build();
  const second = blocks[1];
  assert.equal(second?.type, "context");
  assert.equal(second?.type === "context" ? second.elements[0]?.text : "", "*Lil Bull*");
});

test("footer is the last block: generated timestamp + Godley Innovations OS", () => {
  const { blocks } = build();
  const last = blocks[blocks.length - 1];
  assert.equal(last?.type, "context");
  const text = last?.type === "context" ? (last.elements[0]?.text ?? "") : "";
  assert.equal(text, "Generated 2026-08-17 13:05 UTC · Godley Innovations OS");
});

test("stances render as a labeled section with bold names, dollar levels intact", () => {
  const stances = sectionTexts(build().blocks).find((t) => t.startsWith("*Stances*"));
  assert.ok(stances, "no *Stances* section");
  assert.match(stances, /\*S&amp;P 500:\* Bullish - key level 7652\.86 \(daily SMA50\)/);
  assert.match(stances, /\*SNDK:\* Neutral - key level \$1493\.12 \(latest close\)/);
  assert.match(stances, /\*INTEL:\* Bearish/);
});

test("timeframe table renders inside a code block, cells intact", () => {
  const table = sectionTexts(build().blocks).find((t) => t.startsWith("*Timeframes*"));
  assert.ok(table, "no *Timeframes* section");
  assert.match(table, /^\*Timeframes\*\n```\n/);
  assert.match(table, /```$/);
  assert.ok(table.includes("INTEL: 1H MA↓(2b) MACD-↓ SRSI 34 | 1D +0.4% MA↑(12b) MACD+↓ SRSI 48"));
  assert.ok(table.includes("S&amp;P 500: 1H"), "entities stay escaped even inside the code block");
});

test("calendar items become bullets", () => {
  const week = sectionTexts(build().blocks).find((t) => t.startsWith("*This week*"));
  assert.ok(week, "no *This week* section");
  assert.ok(week.includes("• Wed: FOMC minutes"));
  assert.ok(week.includes("• Fri: Powell speaks at Jackson Hole"));
});

test("sentiment and lean get bold labels; mrkdwn entities are escaped", () => {
  const texts = sectionTexts(build().blocks);
  const sentiment = texts.find((t) => t.startsWith("*Sentiment:*"));
  assert.ok(sentiment, "no *Sentiment:* section");
  assert.ok(sentiment.includes("S&amp;P 500"), "ampersand must be escaped for mrkdwn");
  assert.ok(texts.some((t) => t.startsWith("*Week lean:* Long - Medium conviction")));
});

test("feed-error note is flagged as a warning", () => {
  assert.ok(sectionTexts(build().blocks).some((t) => t === "⚠️ SNDK: data unavailable this week (feed error)."));
});

test("legend and disclaimer are context blocks, not sections", () => {
  const contexts = contextTexts(build().blocks);
  assert.ok(contexts.some((t) => t.startsWith("Legend — MA pairs")));
  assert.ok(contexts.some((t) => t === DISCLAIMER));
});

test("notification fallback text is title + venture", () => {
  assert.equal(build().text, "Lil Bull Weekly Market Brief — week of 2026-08-17 — Lil Bull");
});

test("Slack hard limits hold: header ≤150, sections ≤3000, ≤50 blocks", () => {
  const { blocks } = build();
  assert.ok(blocks.length <= 50);
  for (const block of blocks) {
    if (block.type === "header") assert.ok(block.text.text.length <= 150);
    if (block.type === "section") assert.ok(block.text.text.length <= 3000);
  }
});

test("no-data brief variant still renders header, warning, and footer", () => {
  const noData = [
    "Lil Bull Weekly Market Brief — week of 2026-08-17",
    "Market data unavailable this week — no indicator readings, no stances. We do not guess numbers.",
    DISCLAIMER,
  ].join("\n\n");
  const { blocks } = build(noData);
  assert.equal(blocks[0]?.type, "header");
  assert.ok(sectionTexts(blocks).some((t) => t.startsWith("⚠️ Market data unavailable this week")));
  const last = blocks[blocks.length - 1];
  assert.ok(last?.type === "context" && (last.elements[0]?.text ?? "").includes("Godley Innovations OS"));
});

test("a section the formatter has never seen passes through instead of disappearing", () => {
  const withExtra = `${FULL_BRIEF}\n\nBot performance: paper account up on the week.`;
  assert.ok(sectionTexts(build(withExtra).blocks).includes("Bot performance: paper account up on the week."));
});

test("an oversized section is split, never dropped or over-limit", () => {
  const longLines = Array.from({ length: 200 }, (_, i) => `line ${i} of an unusually long report section`).join("\n");
  const { blocks } = build(`Lil Bull Weekly Market Brief — week of 2026-08-17\n\n${longLines}\n\n${DISCLAIMER}`);
  const pieces = sectionTexts(blocks).filter((t) => t.includes("unusually long report section"));
  assert.ok(pieces.length > 1, "long section should split into multiple blocks");
  for (const piece of pieces) assert.ok(piece.length <= 3000);
  const joined = pieces.join("\n");
  assert.ok(joined.includes("line 0 of") && joined.includes("line 199 of"), "no content may be lost in the split");
});

test("formatUtc renders minute-precision UTC", () => {
  assert.equal(formatUtc(new Date("2026-08-17T13:05:33.123Z")), "2026-08-17 13:05 UTC");
});
