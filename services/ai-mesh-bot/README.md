# AI Mesh Bot (`services/ai-mesh-bot/`)

Slack bot that routes @mentions to different AI personas (Claude, ChatGPT,
Gemini, Lindy AI) and relays their replies back into the thread. First
service in this repo; it is a plain Node HTTP server with zero runtime
dependencies, deployable to any Node host. The frontend app deploys via
Vercel from `main` as before — this service does not affect that.

### Core rules (do not change without discussion)

- **Mention-triggered only.** The bot never reacts to messages it wasn't
  @mentioned in, and never reacts to other bots' messages. This is what
  prevents an infinite AI-reply loop. Any change to routing logic must
  preserve this.
- **Only the `claude` persona can write to the Godley Innovations OS.**
  `handleTurn()` in `index.js` checks `persona === "claude"` before calling
  `writeToOS()`. ChatGPT, Gemini, and Lindy can post replies to Slack but
  their `osUpdate` field is always ignored. This is a deliberate access
  boundary, not a placeholder — don't loosen it without explicit sign-off.

Both rules are enforced by `scripts/check-mesh-bot.mjs` (part of
`npm run check`): it fails the build if the guard code or its markers
disappear from `index.js`.

### Persona routing

One Slack app, four personas. The first word after the @mention picks the
persona (`@AI Mesh gemini summarize this thread`); no persona word means
`claude`. Chosen over separate Slack apps per persona because one app means
one signing secret, one event subscription, and one place where the
no-bot-echo guard lives.

### Bridge contract

Each persona's webhook (`CLAUDE_WEBHOOK_URL`, `CHATGPT_WEBHOOK_URL`,
`GEMINI_WEBHOOK_URL`, `LINDY_WEBHOOK_URL` in the environment) is a small
service that actually calls the model API. `index.js` sends and expects:

**Request body (POST from index.js → bridge):**

```json
{
  "instruction": "clean text with @mentions stripped out",
  "context": [{ "user": "U123", "text": "prior thread message" }],
  "channel": "C0123456",
  "threadTs": "1699999999.000100",
  "raw": { "...original Slack event object" }
}
```

**Expected response (bridge → index.js):**

```json
{
  "reply": "text to post back into the Slack thread",
  "osUpdate": { "...arbitrary object, only honored for the claude persona, else null" }
}
```

A persona whose webhook URL env var is unset is simply not routable yet —
the bot says so in the thread instead of failing silently.

### OS webhook

`GODLEY_OS_WEBHOOK_URL` points at the `os-ingest` Supabase Edge Function
(`supabase/functions/os-ingest/`), which writes to the same database the
app uses. The tracking layer is Supabase — decided, since the OS already
lives there. See that function's comments for the payload shape
(`ledger.add`, `ticket.add`, `note.append`). `OS_WEBHOOK_SECRET` must match
the secret set on the function.

### Build order

1. ~~Router (this service) + OS webhook~~ — built.
2. Claude bridge (has OS write access — get it right and tested in Slack
   before moving on).
3. ChatGPT / Gemini / Lindy bridges — same contract, lower stakes, follow
   the Claude bridge's pattern once it's proven.
4. Handoff parsing (one AI's reply auto-triggering another via
   "@gemini ...") — only after the mention-only loop has run stable for
   a while.

### Setup (all secrets stay server-side; none in this repo, ever)

1. Create a Slack app (api.slack.com/apps) → enable **Event Subscriptions**
   → subscribe to the `app_mention` bot event → install to workspace.
2. Deploy this service to a Node host (Render/Railway/Fly all work; it is
   one file, `node index.js`, listens on `$PORT`). Set env vars there:
   - `SLACK_SIGNING_SECRET` — Slack app → Basic Information
   - `SLACK_BOT_TOKEN` — Slack app → OAuth (starts `xoxb-`)
   - `CLAUDE_WEBHOOK_URL` (+ the other three when their bridges exist)
   - `GODLEY_OS_WEBHOOK_URL`, `OS_WEBHOOK_SECRET`
3. Point the Slack app's event Request URL at `https://<host>/slack/events`.
   The bot answers Slack's URL-verification challenge automatically.

### Style notes

Plain `fetch`, small single-purpose functions, comments explaining *why* a
guard exists (not just what it does) for anything touching the
mention-trigger or OS-write-access logic — those two are safety-critical to
this design and future sessions need the reasoning, not just the code.
