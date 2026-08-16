// Pure indicator math for the Lil Bull Weekly Market Brief. No I/O, no Deno
// APIs — this file is imported by the edge function AND unit-tested from Node
// (scripts/check-indicators.mjs) via Node 22's native type stripping, same
// trick check-config.mjs uses for the module config.
//
// The rule this file exists to enforce: THE MODEL NEVER STATES AN INDICATOR
// VALUE IT WASN'T HANDED. Every number in the brief's timeframe table comes
// out of these functions, computed from fetched candles; the model only
// writes prose around them. Every function returns null when the series is
// too short — "n/a" in the brief, never a guess.
//
// Adding an indicator is one function returning { label, summary } plus one
// entry in the INDICATORS registry at the bottom.

export interface Candle {
  t: number; // unix seconds
  c: number; // close
}

export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (values.length < n) return out;
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n; // SMA seed
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder RSI(14): seed averages from the first `period` moves, then smooth.
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export interface MacdState {
  histSign: "bullish" | "bearish";
  histRising: boolean;
  lineAboveSignal: boolean;
}

export function macdState(closes: number[]): MacdState | null {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const line: (number | null)[] = closes.map((_, i) =>
    fast[i] !== null && slow[i] !== null ? (fast[i] as number) - (slow[i] as number) : null,
  );
  const defined = line.filter((v): v is number => v !== null);
  if (defined.length < 9 + 2) return null;
  const signalDefined = ema(defined, 9);
  const last = defined.length - 1;
  const sig = signalDefined[last];
  const sigPrev = signalDefined[last - 1];
  if (sig === null || sigPrev === null) return null;
  const hist = defined[last] - sig;
  const histPrev = defined[last - 1] - sigPrev;
  return {
    histSign: hist >= 0 ? "bullish" : "bearish",
    histRising: hist > histPrev,
    lineAboveSignal: defined[last] > sig,
  };
}

export interface StochRsiState {
  k: number; // 0..100
  d: number;
  zone: "overbought" | "oversold" | "neutral";
  kAboveD: boolean;
}

export function stochRsiState(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): StochRsiState | null {
  const r = rsi(closes, rsiPeriod).filter((v): v is number => v !== null);
  if (r.length < stochPeriod + kSmooth + dSmooth) return null;
  const stoch: number[] = [];
  for (let i = stochPeriod - 1; i < r.length; i++) {
    const win = r.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...win);
    const hi = Math.max(...win);
    // A collapsed window (RSI perfectly flat) has no direction — read it as
    // neutral 50, not 0, which would fake an oversold signal.
    stoch.push(hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100);
  }
  const kSeries = sma(stoch, kSmooth).filter((v): v is number => v !== null);
  const dSeries = sma(kSeries, dSmooth).filter((v): v is number => v !== null);
  if (kSeries.length === 0 || dSeries.length === 0) return null;
  const k = kSeries[kSeries.length - 1];
  const d = dSeries[dSeries.length - 1];
  return {
    k: Math.round(k),
    d: Math.round(d),
    zone: k >= 80 ? "overbought" : k <= 20 ? "oversold" : "neutral",
    kAboveD: k > d,
  };
}

export interface MaCrossState {
  pair: string; // e.g. "EMA9/21"
  direction: "bullish" | "bearish"; // fast vs slow now
  barsSinceCross: number | null; // null = no cross within the data
  crossDate: string | null; // ISO date of the last cross, if any
}

export function maCrossState(
  candles: Candle[],
  fastN: number,
  slowN: number,
  kind: "ema" | "sma",
): MaCrossState | null {
  const closes = candles.map((c) => c.c);
  const f = kind === "ema" ? ema(closes, fastN) : sma(closes, fastN);
  const s = kind === "ema" ? ema(closes, slowN) : sma(closes, slowN);
  const diffs: { i: number; d: number }[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (f[i] !== null && s[i] !== null) diffs.push({ i, d: (f[i] as number) - (s[i] as number) });
  }
  if (diffs.length < 2) return null;
  const last = diffs[diffs.length - 1];
  // A flat stretch (diff exactly 0) has no side; carry the previous sign so
  // flatness never manufactures a cross. A cross is a genuine sign flip.
  const signs: number[] = [];
  for (let j = 0; j < diffs.length; j++) {
    const s = Math.sign(diffs[j].d);
    signs.push(s !== 0 ? s : signs[j - 1] ?? 0);
  }
  let crossAt: number | null = null;
  for (let j = signs.length - 1; j > 0; j--) {
    if (signs[j] !== 0 && signs[j - 1] !== 0 && signs[j] !== signs[j - 1]) {
      crossAt = j;
      break;
    }
  }
  return {
    pair: `${kind.toUpperCase()}${fastN}/${slowN}`,
    direction: last.d >= 0 ? "bullish" : "bearish",
    barsSinceCross: crossAt === null ? null : diffs.length - 1 - crossAt,
    crossDate: crossAt === null ? null : new Date(candles[diffs[crossAt].i].t * 1000).toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Frame read: everything the brief reports for one index on one timeframe.
// ---------------------------------------------------------------------------

export interface FrameConfig {
  frame: string; // "1H" | "1D" | "1W" | "1M" | "3M" | "1Y"
  maKind: "ema" | "sma";
  maFast: number;
  maSlow: number;
}

export interface FrameRead {
  frame: string;
  changePct: number | null; // % change over the frame's window
  macd: MacdState | null;
  stochRsi: StochRsiState | null;
  maCross: MaCrossState | null;
}

// The registry: one entry per indicator. Adding an indicator = one compute
// function above + one line here; the table builder renders whatever is
// present on the FrameRead.
export function readFrame(candles: Candle[], cfg: FrameConfig, windowBars: number | null): FrameRead {
  const closes = candles.map((c) => c.c);
  let changePct: number | null = null;
  if (windowBars !== null && closes.length > windowBars) {
    const start = closes[closes.length - 1 - windowBars];
    changePct = ((closes[closes.length - 1] - start) / start) * 100;
  }
  return {
    frame: cfg.frame,
    changePct,
    macd: macdState(closes),
    stochRsi: stochRsiState(closes),
    maCross: maCrossState(candles, cfg.maFast, cfg.maSlow, cfg.maKind),
  };
}

// Compact, phone-scannable cell for the table. "n/a" wherever data was short.
export function renderFrame(read: FrameRead): string {
  const arrow = (b: boolean) => (b ? "↑" : "↓");
  const parts: string[] = [];
  if (read.maCross) {
    const since = read.maCross.barsSinceCross === null ? "" : `(${read.maCross.barsSinceCross}b)`;
    parts.push(`MA${read.maCross.direction === "bullish" ? "↑" : "↓"}${since}`);
  } else parts.push("MA n/a");
  if (read.macd) {
    parts.push(`MACD${read.macd.histSign === "bullish" ? "+" : "-"}${arrow(read.macd.histRising)}`);
  } else parts.push("MACD n/a");
  if (read.stochRsi) {
    const z = read.stochRsi.zone === "overbought" ? "ob" : read.stochRsi.zone === "oversold" ? "os" : "";
    parts.push(`SRSI ${read.stochRsi.k}${z}`);
  } else parts.push("SRSI n/a");
  const chg = read.changePct === null ? "" : ` ${read.changePct >= 0 ? "+" : ""}${read.changePct.toFixed(1)}%`;
  return `${read.frame}${chg} ${parts.join(" ")}`;
}
