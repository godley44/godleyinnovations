# CLAUDE.md — Godley Innovations Studio OS

This file is read by every Claude Code session working in this repo. Follow it as standing policy.

## Project

**Godley Innovations Studio OS** — an AI-run venture studio.

- **Slack** = the agents' workrooms. One channel per venture (channel name = `ventures.slug`), plus **#studio-admin** (the owner's console, home of the AI Manager).
- **Supabase** = the system of record.
- **godley-os-bot** (`services/godley-os-bot`, Node/TS/Hono, deployed on Render) = the bot.
- **Vercel app** (repo root, Vite) = approvals inbox + system-of-record UI.
- **Ventures**: `lil-bull` (live); others live in the `ventures` table.

## Non-negotiable rules

1. **Approval gate.** The approval gate is the ONLY path to publishing, sending, or state changes on external platforms. Every automated write files a proposal; `apply_proposal` or the shared decision code paths execute. Never add a bypass. Never auto-approve.

2. **Stop on failure.** Never work around errors silently. Never guess schema — read the migrations first. Never guess third-party API shapes — read the docs; if the docs are unreachable, stop and say so.

3. **Migrations.** Numbered sequentially in `supabase/migrations`, idempotent, validated by the `sql-tests` CI job. Propose the migration in the PR description; do not wait for owner approval to write it (CI is the gate now), but summarize it in phone-readable plain language.

4. **Security.** One API key per service, via env vars. Keys never appear in logs, error messages, chat, commits, or tests (tests assert redaction). No SDKs — plain `fetch`. TypeScript strict. Slack 3-second rule: ack immediately, do the work in the background.

5. **Restart safety.** Claim-before-act ledgers, terminal failures with recorded reasons, delete-row-to-rearm. Dry-run modes for anything that costs money or publishes.

6. **Owner is phone-only and non-technical.** Every report ends with a section titled **"WHAT JUSTIN DOES"** containing ONLY steps that require a human (account creation, pasting a new secret, tapping approve) — written for a phone, one action per line. If nothing is needed, say "Nothing — all automated."

7. **Delivery.** One PR per task, CI green, then enable auto-merge (`gh pr merge --auto --squash`) so it lands itself. After merge, confirm the deploy pipeline succeeded (CI applies migrations + deploys edge functions; Render auto-deploys the bot), and post a one-line summary to #studio-admin via the bot's admin route if available.

8. **Venture isolation.** Anything venture-scoped resolves through `venture_id`. Posts, accounts, and content never cross ventures.

## Current state

_Each session updates this section when it ships something._

- **Bot**: godley-os-bot v0.7.0 — routes: `admin`, `slack-events`, `slack-interactions`; integrations: Anthropic, OpenAI, Blotato.
- **Edge functions**: `claude-bridge`, `os-ingest`, `weekly-insight`.
- **Live features**: proposals/approval gate, Slack prompts + deliveries, weekly insight, WhatsApp framing brief (Lil Bull), content calendar + Blotato social publish pipeline.
- **Tables** (migrations 001–007): `ventures`, `venture_platforms`, `websites`, `social_accounts`, `social_snapshots`, `social_publishes`, `content_calendar`, `proposals`, `money_ledger`, `ad_campaigns`, `support_tickets`, `framing_jobs`, `slack_prompts`, `slack_deliveries`.
- **CI** (`.github/workflows/ci.yml`): `check-and-build` (Vercel app), `bot-build`, `sql-tests` (migrations run against Postgres).
