// weekly-insight v2: the Lil Bull Weekly Market Brief.
//
// Data first, then words. The pipeline fetches real price candles for the
// S&P 500 (^GSPC), NASDAQ Composite (^IXIC), and Dow (^DJI) from Yahoo's
// chart API (keyless; the one unofficial-source concession — swap lives
// entirely in yahooCandles()), computes MACD / StochRSI / MA-cross states in
// code (indicators.ts, guarded by scripts/check-indicators.mjs), and builds
// the timeframe table DETERMINISTICALLY. The model writes only the prose
// around it — stances, calendar, sentiment, lean — from the computed values
// it is handed, plus web search for calendar/news. It is barred from stating
// any market number that isn't in MARKET_DATA. A failed feed renders "data
// unavailable"; numbers are never invented.
//
// Timeframe → candle basis (stated in the brief's legend):
//   1H  hourly candles,   EMA9/21      1M  monthly candles,  SMA50/200
//   1D  daily candles,    EMA9/21      3M  quarterly candles, SMA50/200
//   1W  weekly candles,   EMA9/21      1Y  daily candles,    SMA50/200
//   (Yearly candles don't exist on the feed, and no index has the 200 of
//   them SMA200 would need — the 1Y row is the classic golden-cross read on
//   daily data instead. MACD/StochRSI are omitted there: on daily candles
//   they'd duplicate the 1D row.)
//
// Files through os-ingest as a pending note.append proposal — the approval
// gate is untouched. {"dry_run": true} drafts and returns the brief without
// filing (for testing).
//
// Secrets: WEEKLY_JOB_SECRET, ANTHROPIC_API_KEY, OS_WEBHOOK_SECRET,
// SUPABASE_URL (injected).

import Anthropic from "npm:@anthropic-ai/sdk";
import {
  type Candle,
  type FrameRead,
  maCrossState,
  readFrame,
  renderFrame,
  sma,
} from "./indicators.ts";

type Json = Record<string, unknown>;

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INDEXES = [
  { symbol: "^GSPC", label: "S&P 500", short: "SPX" },
  { symbol: "^IXIC", label: "NASDAQ Composite", short: "NASDAQ" },
  { symbol: "^DJI", label: "Dow Jones Industrial Average", short: "DOW" },
];

// Frame config: candle interval + range fetched + MA pair.
const FRAMES = [
  { frame: "1H", interval: "1h", range: "3mo", maKind: "ema", maFast: 9, maSlow: 21 },
  { frame: "1D", interval: "1d", range: "2y", maKind: "ema", maFast: 9, maSlow: 21 },
  { frame: "1W", interval: "1wk", range: "10y", maKind: "ema", maFast: 9, maSlow: 21 },
  { frame: "1M", interval: "1mo", range: "max", maKind: "sma", maFast: 50, maSlow: 200 },
  { frame: "3M", interval: "3mo", range: "max", maKind: "sma", maFast: 50, maSlow: 200 },
] as const;

// % change windows on daily candles, per displayed frame.
const PCT_WINDOW_DAYS: Record<string, number> = { "1D": 1, "1W": 5, "1M": 21, "3M": 63, "1Y": 252 };

// The one place the data source lives. Swapping providers (e.g. to a keyed
// Alpha Vantage / Twelve Data feed) means replacing this function only.
async function yahooCandles(symbol: string, interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "godley-studio-weekly-brief/1.0" } });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    if (!res.ok) throw new Error(`${symbol} ${interval}: HTTP ${res.status}`);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const ts: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
    const candles: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && isFinite(c)) candles.push({ t: ts[i], c });
    }
    if (candles.length === 0) throw new Error(`${symbol} ${interval}: empty series`);
    return candles;
  }
  throw new Error(`${symbol} ${interval}: rate limited`);
}

interface IndexData {
  short: string;
  label: string;
  ok: boolean;
  error?: string;
  tableLines?: string[];
  latestClose?: number;
  keyLevels?: { label: string; value: number }[];
  weekChangePct?: number;
  frameSummaries?: string[];
}

function pctFromDaily(daily: Candle[], barsBack: number): number | null {
  if (daily.length <= barsBack) return null;
  const now = daily[daily.length - 1].c;
  const then = daily[daily.length - 1 - barsBack].c;
  return ((now - then) / then) * 100;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function analyzeIndex(idx: (typeof INDEXES)[number]): Promise<IndexData> {
  try {
    const bySeries: Record<string, Candle[]> = {};
    for (const f of FRAMES) {
      bySeries[f.frame] = await yahooCandles(idx.symbol, f.interval, f.range);
    }
    const daily10y = await yahooCandles(idx.symbol, "1d", "10y");

    const reads: FrameRead[] = FRAMES.map((f) => {
      const read = readFrame(bySeries[f.frame], f, null);
      read.changePct = f.frame === "1H" ? null : pctFromDaily(daily10y, PCT_WINDOW_DAYS[f.frame]);
      return read;
    });

    // 1Y row: golden-cross basis on daily candles (see header comment).
    const dailyCloses = daily10y.map((c) => c.c);
    const yCross = maCrossState(daily10y, 50, 200, "sma");
    const yPct = pctFromDaily(daily10y, PCT_WINDOW_DAYS["1Y"]);
    const yCell = `1Y${yPct === null ? "" : ` ${yPct >= 0 ? "+" : ""}${yPct.toFixed(1)}%`} ${
      yCross
        ? `MA${yCross.direction === "bullish" ? "↑" : "↓"}${yCross.crossDate ? `(since ${yCross.crossDate})` : ""}`
        : "MA n/a"
    }`;

    const cells = [...reads.map(renderFrame), yCell];
    const tableLines = [
      `${idx.short}: ${cells.slice(0, 3).join(" | ")}`,
      `  ${cells.slice(3).join(" | ")}`,
    ];

    const latest = daily10y[daily10y.length - 1].c;
    const sma50 = sma(dailyCloses, 50).at(-1);
    const sma200 = sma(dailyCloses, 200).at(-1);
    const last20 = daily10y.slice(-20).map((c) => c.c);
    const keyLevels = [
      { label: "latest close", value: round2(latest) },
      ...(sma50 !== null ? [{ label: "daily SMA50", value: round2(sma50) }] : []),
      ...(sma200 !== null ? [{ label: "daily SMA200", value: round2(sma200) }] : []),
      { label: "20-session high", value: round2(Math.max(...last20)) },
      { label: "20-session low", value: round2(Math.min(...last20)) },
    ];

    return {
      short: idx.short,
      label: idx.label,
      ok: true,
      tableLines,
      latestClose: round2(latest),
      keyLevels,
      weekChangePct: pctFromDaily(daily10y, 5) ?? undefined,
      frameSummaries: cells,
    };
  } catch (err) {
    return {
      short: idx.short,
      label: idx.label,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const LEGEND =
  "Legend — MA pairs: 1H/1D/1W EMA9/21 on hourly/daily/weekly candles; 1M SMA50/200 monthly; 3M SMA50/200 quarterly; 1Y SMA50/200 on daily candles (golden-cross basis). MACD 12/26/9: +/- histogram sign, arrow rising/falling. SRSI: StochRSI 14-14-3-3 %K, ob/os over/oversold. (Nb) bars since MA cross. Data: Yahoo Finance candles; indicators computed, not estimated.";

const DISCLAIMER = "Analysis, not financial advice — trade your own plan.";

Deno.serve(async (req) => {
  const secret = Deno.env.get("WEEKLY_JOB_SECRET");
  if (!secret) return reply(500, { ok: false, error: "WEEKLY_JOB_SECRET is not set on this function" });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return reply(401, { ok: false, error: "bad or missing secret" });
  }
  if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return reply(500, { ok: false, error: "ANTHROPIC_API_KEY is not set" });
  const osSecret = Deno.env.get("OS_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!osSecret || !supabaseUrl) {
    return reply(500, { ok: false, error: "OS_WEBHOOK_SECRET / SUPABASE_URL missing from function env" });
  }

  let payload: Json = {};
  try {
    payload = await req.json();
  } catch {
    // Defaults for everything.
  }
  const venture = typeof payload.venture_slug === "string" && payload.venture_slug ? payload.venture_slug : "lil-bull";
  const dryRun = payload.dry_run === true;

  // --- 1. Data ---------------------------------------------------------------
  const indexes: IndexData[] = [];
  for (const idx of INDEXES) {
    indexes.push(await analyzeIndex(idx));
  }
  const okIndexes = indexes.filter((i) => i.ok);
  const today = new Date().toISOString().slice(0, 10);

  // --- 2. Words (model writes prose only; numbers only from MARKET_DATA) ----
  let stancesText = "";
  let calendarText = "";
  let sentimentText = "";
  let leanText = "";
  if (okIndexes.length > 0) {
    const marketData = okIndexes.map((i) => ({
      index: i.short,
      latest_close: i.latestClose,
      week_change_pct: i.weekChangePct === undefined ? null : round2(i.weekChangePct),
      timeframe_reads: i.frameSummaries,
      key_level_candidates: i.keyLevels,
    }));
    const prompt = `Today is ${today}. You are writing prose sections of the Lil Bull Weekly Market Brief for the coming trading week. The indicator table is already built from computed data — you do not repeat it.

MARKET_DATA (computed from real candles — the ONLY permitted source of any price or indicator number in your output):
${JSON.stringify(marketData, null, 2)}

Use web_search for: this coming week's US market calendar (Fed speakers/FOMC, CPI/PPI/jobs data, major earnings) and 2-3 sentences of broad-market sentiment from recent news. NEVER state a price, level, or indicator value from the web — market numbers must come from MARKET_DATA only. Calendar dates/day-names from the web are fine.

Respond with EXACTLY one JSON object, no fences, no other text:
{
  "stances": [{"index": "SPX", "line": "SPX: Bullish|Bearish|Neutral - key level <value> (<label>)"}, ... one per index in MARKET_DATA],
  "calendar": ["<Mon-Fri item>", ... 3 or 4 items, each under 12 words],
  "sentiment": "<2-3 sentences, under 55 words total>",
  "lean": "Week lean: <Long|Short|Neutral> - <High|Medium|Low> conviction - <reason under 10 words>"
}
Rules: each stance's key level MUST be one of that index's key_level_candidates (quote its value and label verbatim); base stance and lean ONLY on the timeframe_reads given; no percentages in conviction; no invented numbers anywhere.`;

    const anthropic = new Anthropic({ apiKey });
    let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    let response;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        response = await anthropic.beta.messages.create({
          model: "claude-opus-5",
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
          messages,
        });
        if (response.stop_reason !== "pause_turn") break;
        messages = [...messages, { role: "assistant", content: response.content }];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply(502, { ok: false, error: `Claude API call failed: ${message}` });
    }
    if (!response || response.stop_reason === "refusal") {
      return reply(502, { ok: false, error: "the model declined to draft the brief" });
    }
    let lastToolIdx = -1;
    response.content.forEach((b, i) => {
      if (b.type === "web_search_tool_result") lastToolIdx = i;
    });
    const text = response.content
      .slice(lastToolIdx + 1)
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
    try {
      const bare = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(bare);
      const stanceLines = Array.isArray(parsed.stances)
        ? parsed.stances.map((s: Json) => String(s.line ?? "")).filter(Boolean)
        : [];
      stancesText = stanceLines.join("\n");
      calendarText = Array.isArray(parsed.calendar)
        ? parsed.calendar.map((c: unknown) => `- ${String(c)}`).join("\n")
        : "";
      sentimentText = typeof parsed.sentiment === "string" ? parsed.sentiment : "";
      leanText = typeof parsed.lean === "string" ? parsed.lean : "";
    } catch {
      return reply(502, { ok: false, error: "model output was not the requested JSON", raw: text.slice(0, 400) });
    }
  }

  // --- 3. Assembly (deterministic) -------------------------------------------
  const failedNote = indexes
    .filter((i) => !i.ok)
    .map((i) => `${i.short}: data unavailable this week (feed error).`)
    .join("\n");
  const table = indexes
    .map((i) => (i.ok ? i.tableLines!.join("\n") : `${i.short}: data unavailable`))
    .join("\n");

  const sections: string[] = [`Lil Bull Weekly Market Brief — week of ${today}`];
  if (okIndexes.length === 0) {
    sections.push("Market data unavailable this week — no indicator readings, no stances. We do not guess numbers.");
  } else {
    if (stancesText) sections.push(stancesText);
    if (failedNote) sections.push(failedNote);
    sections.push(`Timeframes:\n${table}`);
    if (calendarText) sections.push(`This week:\n${calendarText}`);
    if (sentimentText) sections.push(`Sentiment: ${sentimentText}`);
    if (leanText) sections.push(leanText);
    sections.push(LEGEND);
  }
  sections.push(DISCLAIMER);
  const brief = sections.join("\n\n");
  const wordCount = brief.split(/\s+/).filter(Boolean).length;

  if (dryRun) {
    return reply(200, { ok: true, dry_run: true, filed: false, word_count: wordCount, brief });
  }

  // --- 4. File through os-ingest (approval gate unchanged) -------------------
  const ingest = await fetch(`${supabaseUrl}/functions/v1/os-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${osSecret}` },
    body: JSON.stringify({
      venture_slug: venture,
      action: "note.append",
      source: "weekly-insight",
      data: { text: brief },
    }),
  });
  const ingestBody = await ingest.json().catch(() => ({}));
  if (!ingest.ok || ingestBody.ok === false) {
    return reply(502, {
      ok: false,
      error: `os-ingest rejected the proposal: ${ingestBody.error ?? ingest.status}`,
      brief,
    });
  }
  return reply(200, { ok: true, proposal_id: ingestBody.id, venture_slug: venture, word_count: wordCount, brief });
});
