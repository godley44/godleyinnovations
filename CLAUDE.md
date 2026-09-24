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

- **Bot**: godley-os-bot v0.11.0 — routes: `admin` (`deliver-now`, `social-draft`, `video-draft`, `blotato-accounts`, `notify`), `slack-events`, `slack-interactions`; integrations (plain fetch, no SDKs): ElevenLabs (cloned-voice narration), Pictory (video assembly with our narration as `voiceOver.externalVoice`), OpenRouter (the one AI account — the manager as `anthropic/claude-haiku-4.5`, framing as `openai/gpt-4o-mini`, model names are constants in `anthropic.ts` / `openai.ts`), Blotato, plus the direct Anthropic/OpenAI paths behind `AI_PROVIDER=direct` (unset = OpenRouter once `OPENROUTER_API_KEY` exists, else direct with a warning). The edge functions stay on `ANTHROPIC_API_KEY` directly (server-side web search, beta headers — not proxyable). The **AI Manager** answers human messages in #studio-admin; its approve/reject/draft acts run only through `lib/decisions.ts` / `fileSocialDraft` after the owner's explicit "yes" (`pending-actions.ts`, in-memory, fails closed). A non-uuid `proposal_id` from the model (e.g. a made-up placeholder) is resolved against the real pending list before the confirmation gate (`resolvePendingReference` in `manager-acts.ts`); only an unambiguous match resolves.
- **Edge functions**: `claude-bridge`, `os-ingest`, `weekly-insight` — all `verify_jwt = false` in `supabase/config.toml` (shared-secret auth).
- **Live features**: proposals/approval gate, Slack prompts + deliveries, weekly insight, WhatsApp framing brief (Lil Bull), content calendar + Blotato social publish pipeline, AI Manager, voice-first video pipeline (`video.script` approval → `video_jobs` ledger: ElevenLabs narration → Pictory assembly → public `media` bucket → `social.post` approval with a preview link → YouTube/Instagram via Blotato; `VIDEO_DRY_RUN=1` spends nothing).
- **Tables** (migrations 001–007 hand-applied and baselined in the CLI history table; 008 applied by deploy-on-main): `ventures` (+ `elevenlabs_voice_id`, `video_cta`), `venture_platforms`, `websites`, `social_accounts`, `social_snapshots`, `social_publishes`, `content_calendar` (`kind` text|video, `title`), `proposals`, `money_ledger`, `ad_campaigns`, `support_tickets`, `framing_jobs`, `slack_prompts`, `slack_deliveries`, `video_jobs`; Storage bucket `media` (public).
- **CI** (`.github/workflows/ci.yml`): `check-and-build` (Vercel app), `bot-build`, `sql-tests` (migrations run against Postgres), `approval-gate` (`scripts/check-approval-gate.mjs` — fails any PR that bypasses the gate; update its rules in the same commit as a legitimate refactor).
- **Deploy** (`.github/workflows/deploy-on-main.yml`, push to main only): fetch secrets from the Doppler vault → `supabase db push` for new migrations → write the edge functions' secrets from the vault (`supabase secrets set`: `ANTHROPIC_API_KEY`, `OS_WEBHOOK_SECRET`, `BRIDGE_SHARED_SECRET`, whichever are in the vault) → deploy changed edge functions → one-line summary (success or failure) to #studio-admin via `POST /admin/notify`, ending with the secret source. Run #3 went green for the first time on **Sep 23, 2026** (baseline no-op, remote up to date; runs #1–#2 had failed at the secrets guard because `SUPABASE_ACCESS_TOKEN` was missing). The Claude GitHub App has no Actions write permission (`workflow_dispatch` and re-run both return 403), so a session can only trigger a deploy by merging a PR to main; Justin can also tap Run workflow in the Actions tab. Vercel and Render deploy the app and bot themselves.
- **Secrets** (`docs/secrets.md`): one vault — Doppler, project `godley-os`, config `prd`, free Developer plan. The ONLY GitHub repo secret is `DOPPLER_TOKEN` (read-only service token for that config); Render's env is synced by Doppler's Render integration; the edge functions are written from the vault by the deploy. Until `DOPPLER_TOKEN` and every name are in the vault, the workflow falls back per name to the legacy repo secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, `BOT_URL`, `BOT_ADMIN_SECRET`; the #studio-admin summary names the source per run ("secrets: Doppler" with nothing "still from GitHub" = end-to-end verified → delete the four legacy secrets and drop the fallback expressions in a follow-up). Justin populated the vault on **Sep 23, 2026** (nine bot keys, Render integration connected, `DOPPLER_TOKEN` in GitHub, `OPENROUTER_API_KEY` added); the deploy that merged this line is the first vault-sourced run. Sessions never ask for a value to be pasted into Render or GitHub again — the answer is always "paste it into Doppler".
- **Token rotation**: the Supabase access token behind `SUPABASE_ACCESS_TOKEN` was created **Sep 17, 2026** and expires after 90 days (**~Dec 16, 2026**). Rotate it before then: create a new token at supabase.com → Account → Access Tokens, paste it into Doppler (`godley-os` → `prd` → `SUPABASE_ACCESS_TOKEN`; while that name is still only a legacy repo secret, update the repo secret instead) and the Claude environment credential, then re-run deploy-on-main to verify. A reminder is scheduled for Dec 10, 2026. If the token pasted into GitHub on Sep 23 was newly generated that day, its expiry is ~Dec 22, 2026 instead; the Dec 10 reminder covers both.
