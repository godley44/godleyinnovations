# Godley Innovations OS

The operating system for the studio: one workspace ("folder") per venture,
each tracking financials, sales, advertising, social, websites, and support.

Works as a phone app: open the deployed URL on your phone and use
"Add to Home Screen" (Share menu on iOS, browser menu on Android) — it
installs with its own icon and runs full-screen. Same app, same database.

AI agents (via the Slack mesh bot and `os-ingest`) never write to the books
directly: their writes land as **pending proposals**, and the "Needs your
approval" inbox at the top of the app is where you approve or reject them —
in real time, on the phone. Approving runs `apply_proposal()` in the
database, which performs the write and flips the status in one transaction.

Built for one operator working from a tablet in short sessions, with the app
sometimes ahead of the hand-run database. Ground rules live in the code:
every fact in one place, derived numbers never stored, secrets never in the
browser, missing tables degrade to a plain-English message instead of a crash.

## Stack

- React + Vite (frontend, `src/`)
- Supabase (Postgres + auth; schema in `supabase/migrations/`, run by hand)
- Vercel (deploys from `main`)
- GitHub Actions (`.github/workflows/ci.yml` runs checks on every push)

## One-time setup (you do these; they need your accounts)

1. **Supabase**: create a project at supabase.com. In the SQL editor, paste and
   run `supabase/migrations/001_core.sql`.
   - Migration 001 locks every table to the owner email it defines in the
     `is_owner()` function. If your sign-in email ever changes, edit that one
     function.
   - Auth → Providers → Email: leave email OTP enabled (it is by default).
2. **Vercel**: import this GitHub repo, framework preset "Vite", production
   branch `main`. Add environment variables:
   - `VITE_SUPABASE_URL` — Supabase → Project Settings → API → Project URL
   - `VITE_SUPABASE_ANON_KEY` — same page, the `anon` `public` key
   - The `anon` key is public by design; row-level security is the lock.
     The `service_role` key must NEVER be added here or appear anywhere in
     this repo. If a future feature needs it, it goes in a Supabase Edge
     Function secret, server-side only.
3. Open the deployed URL, sign in with the owner email, enter the 6-digit
   code from your inbox.

## Running migrations later

New features sometimes ship before their tables exist (deploys are automatic,
migrations are manual). The app will say exactly which migration to run —
open `supabase/migrations/`, find the lowest-numbered file you haven't run,
run it in the Supabase SQL editor, repeat. Run them in order; each file is
run once, ever.

## Development

```
npm install
npm run dev     # local dev server
npm run check   # typecheck + guard scripts — run before every push
npm run build   # what CI and Vercel run
```

`npm run check` includes guard scripts in `scripts/` that fail if the module
config drifts from the SQL (a tab pointing at a missing table, a select list
that doesn't match a CHECK constraint, unnumbered migrations). When a runtime
bug slips through that the compiler couldn't catch, the fix comes with a new
guard script so it can't happen twice.

## Where things live

- `src/modules/config.ts` — the single source of truth for every tab: which
  table it reads, which fields it shows, which "lens" it applies. Most new
  features start here.
- `supabase/migrations/` — numbered SQL files, run by hand, never edited
  after being run.
- `src/lib/dbErrors.ts` — turns database errors into plain instructions.
- `scripts/` — the guard scripts behind `npm run check`.
- `services/ai-mesh-bot/` — Slack bot routing @mentions to AI personas; see
  its README. Only its `claude` persona may write to the OS, via the
  `os-ingest` function below.
- `supabase/functions/os-ingest/` — server-side write path into the OS for
  trusted automation, gated by a secret that lives only in Supabase function
  secrets. The service-role key is used here and nowhere else. Deployed at
  `https://jvsrlcfkotvmvyxiniid.supabase.co/functions/v1/os-ingest`.
- `supabase/functions/claude-bridge/` — the mesh bot's claude persona: takes
  a Slack instruction, calls the Claude API, returns `{ reply, osUpdate }`.
  Proposes only — the router decides what gets filed and for which venture.
- `supabase/functions/weekly-insight/` — the Lil Bull Weekly Market Brief:
  fetches real index candles (S&P 500, NASDAQ, Dow), computes MACD /
  StochRSI / MA-cross per timeframe in code (`indicators.ts`, guarded by
  `scripts/check-indicators.mjs` — the model never states a number it
  wasn't handed), adds calendar/sentiment via web search, and files the
  brief through `os-ingest` as a pending proposal. Scheduled by migration
  003 (pg_cron, Mondays 13:00 UTC); secrets come from Vault at each firing.
  Once the owner approves it, `services/godley-os-bot` posts the brief to
  the venture's Slack channel, tracked in `slack_deliveries` (migration 004)
  so it can never double-post. Pending proposals themselves reach Slack as
  Approve/Reject button messages (tracked in `slack_prompts`, migration
  005), so approval works from the channel as well as the app. Approved
  briefs are also reframed once (OpenAI, `framing_jobs`, migration 006)
  into a `whatsapp.message` proposal — approved the same way, then handed
  over in Slack as copy-paste text; nothing auto-sends to WhatsApp.
- `docs/lil-bull-interactive-spec.md` — staged spec for the Slack-phase
  interactive features (not built yet).
