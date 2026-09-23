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

- **Bot**: godley-os-bot v0.9.0 — routes: `admin` (`deliver-now`, `social-draft`, `blotato-accounts`, `notify`), `slack-events`, `slack-interactions`; integrations (plain fetch, no SDKs): Anthropic, OpenAI, Blotato. The **AI Manager** answers human messages in #studio-admin; its approve/reject/draft acts run only through `lib/decisions.ts` / `fileSocialDraft` after the owner's explicit "yes" (`pending-actions.ts`, in-memory, fails closed). A non-uuid `proposal_id` from the model (e.g. a made-up placeholder) is resolved against the real pending list before the confirmation gate (`resolvePendingReference` in `manager-acts.ts`); only an unambiguous match resolves.
- **Edge functions**: `claude-bridge`, `os-ingest`, `weekly-insight` — all `verify_jwt = false` in `supabase/config.toml` (shared-secret auth).
- **Live features**: proposals/approval gate, Slack prompts + deliveries, weekly insight, WhatsApp framing brief (Lil Bull), content calendar + Blotato social publish pipeline, AI Manager.
- **Tables** (migrations 001–007, hand-applied and baselined in the CLI history table): `ventures`, `venture_platforms`, `websites`, `social_accounts`, `social_snapshots`, `social_publishes`, `content_calendar`, `proposals`, `money_ledger`, `ad_campaigns`, `support_tickets`, `framing_jobs`, `slack_prompts`, `slack_deliveries`.
- **CI** (`.github/workflows/ci.yml`): `check-and-build` (Vercel app), `bot-build`, `sql-tests` (migrations run against Postgres), `approval-gate` (`scripts/check-approval-gate.mjs` — fails any PR that bypasses the gate; update its rules in the same commit as a legitimate refactor).
- **Deploy** (`.github/workflows/deploy-on-main.yml`, push to main only): `supabase db push` for new migrations → deploy changed edge functions → one-line summary (success or failure) to #studio-admin via `POST /admin/notify`. Needs repo secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, `BOT_URL`, `BOT_ADMIN_SECRET` — all four present since **Sep 23, 2026**, when run #3 went green for the first time (baseline no-op, remote up to date; runs #1–#2 had failed at the secrets guard because `SUPABASE_ACCESS_TOKEN` was missing). The Claude GitHub App has no Actions write permission (`workflow_dispatch` and re-run both return 403), so a session can only trigger a deploy by merging a PR to main; Justin can also tap Run workflow in the Actions tab. Vercel and Render deploy the app and bot themselves.
- **Token rotation**: the Supabase access token behind `SUPABASE_ACCESS_TOKEN` was created **Sep 17, 2026** and expires after 90 days (**~Dec 16, 2026**). Rotate it before then: create a new token at supabase.com → Account → Access Tokens, update the `SUPABASE_ACCESS_TOKEN` repo secret (and the Claude environment credential), then re-run deploy-on-main to verify. A reminder is scheduled for Dec 10, 2026. If the token pasted into GitHub on Sep 23 was newly generated that day, its expiry is ~Dec 22, 2026 instead; the Dec 10 reminder covers both.
