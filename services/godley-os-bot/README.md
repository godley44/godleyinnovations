# Godley OS Bot (`services/godley-os-bot/`)

Slack bot backend for the Godley Innovations OS: an always-on Node/TypeScript
web service (Hono) meant for Render. This build is the **skeleton** — events
in, signatures verified, approvals written to Supabase, health check green.
The research/framing/publishing pipelines are stubs on purpose.

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /health` | Returns `200 ok` — Render health check. |
| `POST /slack/events` | Slack Events API. Answers the one-time `url_verification` challenge and acks everything within Slack's 3-second window. An `@mention` of the bot is the **health probe**: it replies in-thread (after the ack, fire-and-forget) with the bot version, poller status, timestamps of the last successful delivery check and last delivered report, and how many reports need attention (failed or stuck deliveries). |
| `POST /slack/interactions` | Slack interactivity. Approve/Reject buttons write the decision to Supabase, then replace the original message ("✅ Approved by Justin" / "❌ Rejected by Justin"). A failed write is reported in-channel and nothing is retried silently. |
| `POST /admin/deliver-now` | Runs one full poll cycle immediately (delivery, framing, prompts, disarm, publish, confirm — with full Slack channel resolution) and returns the result as JSON — for testing without waiting on the Monday cron. Auth: `Authorization: Bearer <ADMIN_SECRET>`; with the secret unset all admin routes refuse everything. |
| `POST /admin/social-draft` | Files a social post: creates the `content_calendar` row and its `social.post` proposal, which rides the existing approval rails (Slack buttons / app inbox). Drafting never publishes — only approval does. Body: `{ "ventureSlug", "text", "platforms": ["twitter","linkedin"], "mediaUrls"?, "scheduledFor"? }` (`scheduledFor` is informational only this phase). Same bearer auth. |
| `GET /admin/blotato-accounts` | Lists the Blotato accounts behind the real API key (`GET /v2/users/me/accounts`), for assigning `venture_platforms.blotato_account_id` at live-test time. Refuses with a clear message while the key is the `pending` placeholder. Same bearer auth. |

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

## Report delivery (Lil Bull Weekly Market Brief)

The bot's first job: post OS reports into the matching venture channel.
The pipeline (`src/lib/report-poller.ts`, every 60s):

1. **Ready** means approved: `proposals` rows with `action='note.append'`,
   `proposed_by='weekly-insight'`, `status='approved'`. The weekly-insight
   cron (migration 003, Mondays 13:00 UTC) files the brief as a *pending*
   proposal; a brief reaches Slack only after the owner approved it — the
   human-sign-off gate applies to outbound posts exactly as it does to
   database writes.
2. The venture's channel is the one whose **name equals `ventures.slug`**
   (the `venture-map.ts` convention, applied in the venture→channel
   direction via `conversations.list`, cached 15 min). A missing channel or
   a channel the bot isn't a member of is a loud failure with the reason —
   never a guess at an alternate channel.
3. The brief text (the exact `payload.text` the owner approved) renders to
   Block Kit in `src/lib/brief-blocks.ts`: header + venture, stances,
   timeframe table as a code block, calendar bullets, sentiment, lean,
   legend/disclaimer as small context text, and a
   "Generated <UTC time> · Godley Innovations OS" footer. Unit-tested in
   `src/lib/brief-blocks.test.ts` (`npm test`) against fixtures shaped like
   the real weekly-insight output.

4. Delivery is tracked in the **`slack_deliveries` ledger** (migration 004)
   with a claim-before-post protocol, so a report can never be posted twice
   across restarts: the bot inserts a `posting` row (atomic — the table is
   `unique(proposal_id)`) *before* calling Slack, then records `delivered` +
   the message `ts`. Failures (`failed` + reason) are terminal — no silent
   retries: fix the cause (create/invite into the channel, etc.), delete the
   row, and the next cycle re-arms. A row stuck at `posting` means the bot
   died mid-post — the probe and `/admin/deliver-now` surface it; check the
   channel before deleting that row, because deleting a row for a message
   that *did* land re-posts it.

**Deploy order is safe in both directions:** if the bot deploys before
migration 004 has been run, every cycle fails loudly with "run
supabase/migrations/004_slack_deliveries.sql" and nothing is posted.

Slack API calls are plain `fetch` (`src/lib/slack-web.ts`) — no Slack SDK,
same policy as signature verification.

## WhatsApp framing agent (phase 1 of the social backbone)

When a weekly brief is APPROVED, the framing agent
(`src/integrations/openai.ts`, plain fetch, `gpt-4o-mini`) rewrites it as a
WhatsApp-ready message — conversational, headline first, ~1200 chars, no
tables, 2-4 emoji, one closing question, and **barred from stating any
market data not present in the source brief** (the system prompt is a
marked TUNE ME constant). The result is filed as a NEW pending proposal
(`action='whatsapp.message'`, `proposed_by='framing-agent'`, payload
`{ text, source_proposal_id }`) that rides the exact same rails as
everything else: buttons in the channel, approve/reject, disarm — zero new
approval code. On approval, the delivery step posts it to the venture
channel as "WhatsApp message ready" with the text in a code block
(one-tap select-all-copy on mobile). **Nothing ever auto-sends to
WhatsApp** — the last hop is always the owner pasting into the group by
hand.

## Social publishing (phase 2 of the social backbone)

Social posts become OS objects: drafted into a content calendar, approved
through the same proposal rails as everything else, then published to the
venture's platform stack via the Blotato API
(`src/integrations/blotato.ts` — plain fetch against
`https://backend.blotato.com/v2`, auth header `blotato-api-key`, schemas
verified against help.blotato.com/api). Publishing is asynchronous on
Blotato's side: a publish answers with a `postSubmissionId` and the real
outcome (`published` + public URL, or terminal `failed` — their docs say
"do not retry on failed") comes from the status endpoint.

The full chain (migration 007): `POST /admin/social-draft` creates a
`content_calendar` row and files a `social.post` proposal — buttons in the
venture channel, approve/reject, disarm, zero new approval code. Approving
runs `apply_proposal()`, which flips the calendar row `proposed→approved`
in the same transaction; **the approval gate is the ONLY path to
publishing** (`scheduled_for` is stored but informational — nothing
auto-publishes on a schedule this phase). The poller's publish step then
claims each (post, platform) pair in the **`social_publishes` ledger**
(`publishing` → `submitted` → `published`/`failed`, or `dry-run`;
`unique(calendar_id, platform)`) before calling Blotato — one platform
failing never blocks the others, failures are terminal with the reason
recorded (delete the row to re-arm that platform), and a confirm pass
polls submitted publishes until Blotato reports the outcome. The venture
channel gets a one-line-per-platform summary (partial failures show the
successes alongside), and `content_calendar.status` aggregates to
`published`/`partial`/`failed`.

Platform stacks live in **`venture_platforms`** — the publish step resolves
Blotato account ids only through that table for the post's venture, so
posts can never cross ventures. The rows ship with
`blotato_account_id NULL`: the ids are born when the real key is generated
(which starts billing), fetched via `GET /admin/blotato-accounts`, and
assigned by hand in the SQL editor. Publishing refuses loudly per-platform
while an id is NULL.

**Dry run is load-bearing**: with no real key (the Render env ships the
placeholder `pending`) or `BLOTATO_DRY_RUN=1`, `publishPost()` logs the
exact request it would send and the ledger records `dry-run` — the whole
draft→approve→publish chain runs end-to-end before the key exists, and the
calendar row deliberately stays `publishing` (never claims "published" for
a message that was not sent). When the real key lands: assign the account
ids, delete the dry-run ledger rows, and the next cycle publishes for
real. Per-platform rules are enforced at request-build time (YouTube
requires a video plus per-post title, so it is refused until the video
phase; text posts target X/Twitter and LinkedIn).

Framing is tracked in **`framing_jobs`** (migration 006, which also adds
`whatsapp.message` to the proposals action whitelist and teaches
`apply_proposal()` to approve it as a no-database-write): claim-before-run
(`running` → `done`/`failed`, `unique(source_proposal_id)`), exactly one
framing per brief across restarts, terminal failures with the reason
recorded — delete-the-row-to-re-arm, like every other ledger. The framing
step runs after delivery and before the prompts step, so the framed
proposal's buttons post in the same cycle. Poller steps are isolated: a
missing migration fails its own step loudly ("run migration 006") while
deliveries and approvals keep working.

## Slack approval loop (pending proposals → buttons)

The sibling flow to report delivery: PENDING proposals are posted to the
venture's channel with Approve/Reject buttons, wired to the interactions
contract above (`action_id` `approve`/`reject`, proposal id in the button
`value` — defined in `slack-interactions.ts`, rendered by
`src/lib/approval-blocks.ts`, never redefined). After a tap the message is
replaced in place with WHAT was decided — outcome, venture, proposal type,
source, UTC time (`buildDecidedMessage`) — not a bare "Approved". The same
renderer disarms a prompt via `chat.update` when the proposal was decided
outside Slack (the Vercel inbox), so buttons never stay live for a decided
proposal.

Prompts are tracked in **`slack_prompts`** (migration 005) — deliberately a
separate table from `slack_deliveries`, because a weekly-insight proposal
legitimately has BOTH a buttons prompt (pending) and a brief delivery
(after approval), and the two message kinds have different lifecycles. Same
claim-before-post protocol (`posting` → `posted` → `disarmed`/`failed`,
`unique(proposal_id)`), same terminal-failure semantics
(delete-the-row-to-re-arm), same restart safety. The poller's disarm pass
runs every cycle: any `posted` prompt whose proposal is no longer pending
gets `chat.update`d to the decided layout (a hand-deleted message is just
marked disarmed); a decision through the buttons marks its own row
disarmed so the pass doesn't overwrite the "by Justin" attribution. If the
bot deploys before migration 005 has been run, report delivery keeps
working and the prompt steps fail loudly with "run migration 005".

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
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SECRET`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BLOTATO_API_KEY`.

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
