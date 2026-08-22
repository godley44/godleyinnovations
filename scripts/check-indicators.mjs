// Guard script: the Weekly Market Brief's indicator math, checked against
// hand-computable synthetic series. The brief's core promise is that every
// number in it was computed from real candles — so the computing functions
// get the same treatment as the SQL and the mesh-bot invariants: a guard
// that fails loudly if the math drifts.
//
// Node 22 strips TS types natively, so this imports the exact module the
// edge function ships — not a copy that could drift (same trick as
// check-config.mjs).

import {
  sma,
  ema,
  rsi,
  macdState,
  stochRsiState,
  maCrossState,
  readFrame,
  renderFrame,
} from "../supabase/functions/weekly-insight/indicators.ts";

const failures = [];
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
const approx = (a, b, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

// --- SMA/EMA: hand-computed tiny cases -------------------------------------
{
  const s = sma([1, 2, 3, 4], 2);
  check("sma warmup is null", s[0] === null);
  check("sma values", approx(s[1], 1.5) && approx(s[2], 2.5) && approx(s[3], 3.5), JSON.stringify(s));

  // ema(n=3): seed = SMA(1,2,3) = 2 at index 2; k = 0.5
  // idx3: 4*0.5 + 2*0.5 = 3;  idx4: 5*0.5 + 3*0.5 = 4
  const e = ema([1, 2, 3, 4, 5], 3);
  check("ema warmup is null", e[0] === null && e[1] === null);
  check("ema seed + recursion", approx(e[2], 2) && approx(e[3], 3) && approx(e[4], 4), JSON.stringify(e));
}

// --- RSI: extremes and mirror symmetry --------------------------------------
{
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
  const rUp = rsi(rising).at(-1);
  const rDown = rsi(falling).at(-1);
  check("rsi of monotonic rise is 100", approx(rUp, 100), String(rUp));
  check("rsi of monotonic fall is 0", approx(rDown, 0), String(rDown));

  // Mirror: reflecting a series about a constant maps gains<->losses, so
  // rsi(reflected) must equal 100 - rsi(original) at every defined index.
  const wobble = Array.from({ length: 60 }, (_, i) => 100 + 10 * Math.sin(i / 3) + i / 7);
  const mirrored = wobble.map((v) => 200 - v);
  const a = rsi(wobble);
  const b = rsi(mirrored);
  const mirrorOk = a.every((v, i) => (v === null) === (b[i] === null) && (v === null || approx(b[i], 100 - v, 1e-6)));
  check("rsi mirror symmetry", mirrorOk);
}

// --- MACD: sign follows a fresh, sustained move ------------------------------
// (A steady exponential decay reads "bullish histogram" late in the move —
// decelerating decline — which is correct MACD behavior; the discriminating
// test is a fresh reversal out of a flat base.)
{
  const flatThenUp = [
    ...Array.from({ length: 40 }, () => 100),
    ...Array.from({ length: 12 }, (_, i) => 100 + (i + 1) * 2),
  ];
  const flatThenDown = [
    ...Array.from({ length: 40 }, () => 100),
    ...Array.from({ length: 12 }, (_, i) => 100 - (i + 1) * 2),
  ];
  check("macd bullish on fresh breakout up", macdState(flatThenUp)?.histSign === "bullish");
  check("macd bearish on fresh breakdown", macdState(flatThenDown)?.histSign === "bearish");
  check("macd null when short", macdState([1, 2, 3, 4, 5]) === null);
}

// --- StochRSI: zones at extremes, neutrality when degenerate ----------------
{
  // Wobble keeps RSI un-pinned; a strong final leg drives RSI to its window
  // max → stoch → 100 → overbought. Mirrored for oversold.
  const wobble = Array.from({ length: 50 }, (_, i) => 100 + 3 * Math.sin(i / 2));
  const up = [...wobble, ...Array.from({ length: 10 }, (_, i) => 104 + (i + 1) * 3)];
  const down = [...wobble, ...Array.from({ length: 10 }, (_, i) => 96 - (i + 1) * 3)];
  const stUp = stochRsiState(up);
  const stDown = stochRsiState(down);
  check("stochrsi overbought after strong final leg up", stUp?.zone === "overbought", JSON.stringify(stUp));
  check("stochrsi oversold after strong final leg down", stDown?.zone === "oversold", JSON.stringify(stDown));
  // Perfectly flat RSI (monotonic line pins RSI at 100) must read neutral —
  // a collapsed stoch window is directionless, not oversold.
  const pinned = stochRsiState(Array.from({ length: 80 }, (_, i) => 100 + i));
  check("degenerate flat-RSI window reads neutral", pinned?.zone === "neutral", JSON.stringify(pinned));
  check("stochrsi null when short", stochRsiState([1, 2, 3]) === null);
  check("stochrsi k in range", stUp !== null && stUp.k >= 0 && stUp.k <= 100);
}

// --- MA cross: direction, recency, and date ---------------------------------
{
  const DAY = 86400;
  const t0 = Date.UTC(2026, 0, 1) / 1000;
  // 30 bars declining, then 15 bars rising hard: EMA3 crosses above EMA5
  // shortly after the reversal — bullish, recent, dated inside the rally.
  const candles = [
    ...Array.from({ length: 30 }, (_, i) => ({ t: t0 + i * DAY, c: 130 - i })),
    ...Array.from({ length: 15 }, (_, i) => ({ t: t0 + (30 + i) * DAY, c: 101 + (i + 1) * 3 })),
  ];
  const x = maCrossState(candles, 3, 5, "ema");
  check("cross detected as bullish", x?.direction === "bullish", JSON.stringify(x));
  check("cross is recent (within the rally)", x !== null && x.barsSinceCross !== null && x.barsSinceCross < 15);
  check("cross date lands in the rally window", x !== null && x.crossDate !== null && x.crossDate >= "2026-01-31", String(x?.crossDate));
  check("pair label", x?.pair === "EMA3/5");

  // Flat series: no sign ever establishes, so no cross — and no fake one.
  const flat = Array.from({ length: 40 }, (_, i) => ({ t: t0 + i * DAY, c: 100 }));
  const noCross = maCrossState(flat, 3, 5, "ema");
  check("flat series has no cross", noCross !== null && noCross.barsSinceCross === null);
}

// --- Frame read + render: n/a on short data, no invented numbers ------------
{
  const DAY = 86400;
  const t0 = Date.UTC(2026, 0, 1) / 1000;
  const short = Array.from({ length: 5 }, (_, i) => ({ t: t0 + i * DAY, c: 100 + i }));
  const read = readFrame(short, { frame: "1D", maKind: "ema", maFast: 9, maSlow: 21 }, null);
  check("short data yields nulls, not numbers", read.macd === null && read.stochRsi === null);
  const cell = renderFrame(read);
  check("short data renders as n/a", cell.includes("MACD n/a") && cell.includes("SRSI n/a"), cell);
}

if (failures.length > 0) {
  console.error("check-indicators FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("check-indicators OK: indicator math verified against synthetic series.");
