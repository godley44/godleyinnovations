# Lil Bull — interactive features spec (staged, not built)

Status: **staged for the Slack phase.** Nothing below is implemented; this
file exists so the weekly brief (built) and the interactive layer (later)
don't blur together. The trading bot itself stays parked per standing order —
nothing here executes trades.

Everything below inherits two non-negotiables from the weekly brief:

1. **No invented numbers.** Any price, level, or indicator value shown to the
   user is computed from fetched data or read from a user-supplied chart.
   Feed fails → "data unavailable", never a guess.
2. **The approval gate stands.** Anything that writes to the OS goes through
   `os-ingest` as a pending proposal. Interactive replies (analysis in Slack)
   don't write at all.

## Features

### 1. Chart-image analysis
User posts a chart screenshot in Slack (@mention). The claude persona reads
it and returns: directional lean (long/short/neutral) + conviction
(High/Medium/Low, no percentages) + the 2-3 observations driving it.
Numbers visible on the chart may be cited; numbers not visible may not.

### 2. Fair Value Gap (FVG) analysis
On request (chart image or symbol+timeframe): identify unfilled fair value
gaps, their price ranges, and whether current price is approaching one.
Computed from candle data where a symbol is given; read from the image where
a chart is given.

### 3. Four-price-point move check
A go/no-go screen: does the setup show the four price points the playbook
requires? **When absent, the answer is an explicit "No trade" with the
reasoning** (which points are missing and what would need to print) — never
a hedge, never silence.

### 4. Calls/puts framing
When the lean supports it, frame the idea as it would be traded with options:
direction, expiry bucket (weekly/monthly), near-the-money vs OTM posture.
Framing only — no chains fetched, no fills, no sizing advice. Ends with the
standard disclaimer line.

### 5. TradingView Pine Script support
Generate and debug Pine Script v5+ indicators/strategies on request —
starting with the brief's own stack (MACD 12/26/9, StochRSI 14-14-3-3,
EMA9/21, SMA50/200) so TradingView charts can mirror the brief exactly.

### 6. End-of-day summaries
On-demand (later: scheduled) EOD note per index or watched symbol: close vs
key levels, indicator state changes since the morning, one-line read.
Same computed-data rule; files to the OS only as a proposal if asked.

### 7. Shareable updates
3-6 sentence WhatsApp-ready updates on request ("give me the mid-week
pulse") — same voice and disclaimers as the weekly brief, built from the
same computed data.

## Sequencing note

These land with the Slack phase (router already supports the claude persona
and channel→venture routing). Suggested order: 1 → 3 → 7 (image analysis,
go/no-go, shareables) since they share the vision + framing core; 5 is
independent; 2 and 4 build on 1; 6 last since scheduling infra exists but
per-symbol watchlists don't.
