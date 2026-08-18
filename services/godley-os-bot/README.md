# Godley OS Bot (`services/godley-os-bot/`)

Slack bot backend for the Godley Innovations OS: an always-on Node/TypeScript
web service (Hono) meant for Render. This build is the **skeleton** — events
in, signatures verified, approvals written to Supabase, health check green.
The research/framing/publishing pipelines are stubs on purpose.

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /health` | Returns `200 ok` — Render health check. |
| `POST /slack/events` | Slack Events API. Answers the one-time `url_verification` challenge; for `app_mention` and `message.channels` events from humans it logs and acks within Slack's 3-second window (processing is a fire-and-forget hook for later). |
| `POST /slack/interactions` | Slack interactivity. Approve/Reject buttons write the decision to Supabase, then replace the original message ("✅ Approved by Justin" / "❌ Rejected by Justin"). A failed write is reported in-channel and nothing is retried silently. |

Both Slack routes verify the request signature by hand (no Slack SDK): HMAC
SHA-256 over `v0:<timestamp>:<raw body>` with the signing secret, timing-safe
comparison, and requests older than five minutes rejected. Verification runs
**before** the challenge answer — Slack signs the handshake too, so setup
still works, and no unsigned byte is ever interpreted.

## How "approvals" map to the database

There is no `approvals` table. The approvals inbox is the **`proposals`**
table (`supabase/migrations/002_proposals.sql`), and this bot mirrors the
app's Approve/Reject buttons (`src/components/ApprovalsCard.tsx`) exactly:

- **Approve** calls the `apply_proposal(p_id)` database function — it
  performs the proposed write (ledger row / ticket / note), flips `status`
  to `approved`, and sets `decided_at` in one transaction. Approving IS the
  write; a bare status update would strand the payload forever.
- **Reject** updates `status='rejected'` + `decided_at`, guarded by
  `status='pending'` so an already-decided proposal is never flipped.

The Slack button's `value` must carry the proposal id. Whatever posts
approval messages later (the pipeline) owns that contract.

Channel → venture routing lives in `src/lib/venture-map.ts`: channel name
equals `ventures.slug` (`#lil-bull` → slug `lil-bull`); `resolveVenture`
throws a clear error when no venture matches.

## The 3-second rule

Slack retries anything not acked within 3 seconds, so every route returns
its 200 immediately and anything slow (Supabase, Anthropic, OpenAI) runs
after the ack — fire-and-forget with error logging, and for interactions the
outcome is delivered through the payload's `response_url` (valid 30
minutes). Keep it that way when the pipeline lands.

## Environment variables

All documented with placeholders in [`.env.example`](.env.example) — copy to
`.env` locally, set real values only in the Render dashboard:

`PORT` (Render injects it), `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `BLOTATO_API_KEY`.

## Local development

```bash
cd services/godley-os-bot
npm install
cp .env.example .env   # fill in real values
npm run dev            # tsx watch src/index.ts
npm run build && npm start   # what Render runs
```

`.env` is auto-loaded when it exists (Node's built-in loader, needs Node
20.12+); on Render there is no `.env` and the dashboard-injected environment
is used as-is.

## Deploy to Render

The service deploys from this monorepo, not a separate repo:

1. In the Render dashboard: **New → Web Service**, connect the
   `godley44/godleyinnovations` GitHub repo.
2. Set **Root Directory** to `services/godley-os-bot`. Render runs every
   command from that directory and auto-deploys only when files under it
   change — pushes that touch just the frontend don't redeploy the bot.
3. Settings: runtime **Node**, build command `npm install && npm run build`,
   start command `npm start`, health check path `/health`, plan **Starter**
   (always-on; the free tier sleeps and would miss Slack's 3-second window).
4. Add the environment variables in the Render dashboard (Environment tab):
   `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `BLOTATO_API_KEY`. (`PORT` is injected by Render automatically.)
5. Deploy. When the health check at `/health` is green, point the Slack app
   at it (below).

`render.yaml` in this directory documents the same configuration. Render's
blueprint auto-detection only reads a repo-root `render.yaml`, so with the
monorepo the dashboard settings above are what counts — the file is the
config of record and becomes auto-detectable if the service ever moves to
its own repo.

### Slack app configuration

1. api.slack.com/apps → your app → **Event Subscriptions** → enable, set
   Request URL to `https://<service>.onrender.com/slack/events` (the bot
   answers the verification challenge), subscribe to bot events
   `app_mention` and `message.channels`.
2. **Interactivity & Shortcuts** → enable, set Request URL to
   `https://<service>.onrender.com/slack/interactions`.
3. Install the app to the workspace; put the signing secret and bot token in
   Render's environment.
