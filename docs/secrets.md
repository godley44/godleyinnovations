# Secrets: the Doppler vault

Every production secret of the studio lives in **one place**: the Doppler
vault, project **`godley-os`**, config **`prd`**. The three places that need
secrets are fed from that config — nothing is typed into Render, GitHub, or
Supabase by hand any more:

| Consumer | How it gets the secrets |
| --- | --- |
| **Render** (`godley-os-bot`) | Doppler's native Render integration syncs config `prd` into the service's environment (Doppler → Integrations → Render, pointed at the `godley-os-bot` service). Render redeploys when a value changes. |
| **GitHub Actions** (`deploy-on-main.yml`) | The single repo secret **`DOPPLER_TOKEN`** — a read-only *service token* for `godley-os/prd`. `dopplerhq/secrets-fetch-action` fetches the config at run time and masks every value in the log. |
| **Supabase edge functions** | `deploy-on-main` writes `ANTHROPIC_API_KEY`, `OS_WEBHOOK_SECRET`, `BRIDGE_SHARED_SECRET` from the vault with `supabase secrets set` on every deploy (only the names present in the vault; the rest keep their hand-set values). Functions read new values immediately. |

## Why Doppler (decided 2026-09-23)

- Doppler's free **Developer** plan covers all three paths: the Render sync
  is one of its 5 config syncs, GitHub Actions needs only a service token
  (50 included), and the edge functions are fed by the Supabase CLI in the
  deploy workflow. Pricing verified on doppler.com/pricing that day: free
  for 3 users, then $8/user/month; 10 projects, 4 environments.
- Infisical's free plan would also work ($0, 5 identities, 3 environments,
  10 secret syncs; Pro is $20/identity/month annual, $23 monthly) but counts
  the machine identity for GitHub against the 5, and its Render sync and
  GitHub action are newer and fiddlier to set up from a phone.
- One project, one config, one token: the cheapest tier that supports all
  three syncs, on both, is free — Doppler wins on the smaller setup surface.

## Every name, who uses it, where it came from

| Name | Bot (Render) | Deploy (GitHub) | Edge functions | Origin |
| --- | :-: | :-: | :-: | --- |
| `SLACK_SIGNING_SECRET` | ✓ | | | was in Render |
| `SLACK_BOT_TOKEN` | ✓ | | | was in Render |
| `SUPABASE_URL` | ✓ | | (injected by Supabase) | was in Render |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | | (injected by Supabase) | was in Render |
| `ADMIN_SECRET` | ✓ | ✓ (posts the deploy summary) | | was in Render (GitHub held a copy as `BOT_ADMIN_SECRET`) |
| `ANTHROPIC_API_KEY` | ✓ (direct-provider fallback) | | ✓ `claude-bridge`, `weekly-insight` | was in Render and hand-set on Supabase |
| `OWNER_SLACK_USER_ID` | ✓ | | | was in Render |
| `OPENAI_API_KEY` | ✓ (direct-provider fallback) | | | was in Render |
| `BLOTATO_API_KEY` | ✓ | | | was in Render (`pending` = dry run) |
| `OPENROUTER_API_KEY` | ✓ | | | new — the bot's AI calls go through OpenRouter |
| `SUPABASE_ACCESS_TOKEN` | | ✓ | | was a GitHub secret (write-only there — regenerate at supabase.com → Account → Access Tokens when moving it) |
| `SUPABASE_DB_URL` | | ✓ | | was a GitHub secret (Supabase → Connect → Session pooler string, with the DB password) |
| `BOT_URL` | | ✓ | | was a GitHub secret; not secret — the bot's Render URL |
| `OS_WEBHOOK_SECRET` | | ✓ (written to functions) | ✓ `os-ingest`, `weekly-insight` | hand-set on Supabase; the AI Mesh Bot holds the same value |
| `BRIDGE_SHARED_SECRET` | | ✓ (written to functions) | ✓ `claude-bridge` | hand-set on Supabase; the AI Mesh Bot holds the same value |

Not in the vault, on purpose:

- `WEEKLY_JOB_SECRET` — its *caller* half is stored in the **Supabase
  Vault** (`vault.create_secret(..., 'weekly_job_secret')`, migration 003)
  where pg_cron reads it every Monday; the *callee* half is the
  `weekly-insight` function secret. The two must change together, by hand,
  so the deploy never writes one side alone.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — public by design, set in
  Vercel.
- `PORT` — injected by Render.

The Render service's environment now carries every name in the config,
including the deploy-only ones. Accepted for a one-person studio (the bot
already holds the service-role key); the tightening, if ever wanted, is a
Doppler *branch config* `prd_deploy` holding the deploy-only names, with the
service token re-issued for it.

## Transition and the end-to-end check

`deploy-on-main` reads each name from the vault first and falls back, per
name, to the legacy GitHub secret of the same name (`SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_URL`, `BOT_URL`, `BOT_ADMIN_SECRET`) — or to all of them while
`DOPPLER_TOKEN` is not set. Nothing breaks mid-migration.

Every deploy summary in **#studio-admin** ends with the source, names only:

- `secrets: GitHub (DOPPLER_TOKEN not set)` — the vault is not wired yet.
- `secrets: Doppler (still from GitHub: SUPABASE_ACCESS_TOKEN, …)` — the
  token works; the named values are not in the vault yet.
- `secrets: Doppler` — everything came from the vault. **This line is the
  end-to-end proof.** From then on the four legacy GitHub secrets are unused
  and can be deleted (Settings → Secrets and variables → Actions), and the
  fallback expressions in the workflow can go in a follow-up.

The same line reports `function secrets from the vault: …` with any names
not in the vault yet.

## Rotating or changing a secret

1. Doppler → `godley-os` → `prd` → the secret → paste the new value → Save.
2. Render picks it up through the integration and redeploys the bot.
3. GitHub reads the vault live on the next deploy; the edge functions get the
   new value on the next deploy too (or right away with a manual *Run
   workflow* on deploy-on-main in the Actions tab).

Nothing is ever pasted into Render or GitHub again. Keys never appear in
logs, error messages, chat, commits, or tests — the fetch action masks vault
values, and every step prints names only.
