-- ============================================================================
-- Migration 003: the weekly insight schedule.
-- Run after 002, once, in the Supabase SQL editor (or via the Management API).
--
-- Every Monday 13:00 UTC, pg_cron fires pg_net, which POSTs to the
-- weekly-insight edge function; the function drafts a market-insight note
-- and files it through os-ingest as a pending proposal against lil-bull.
-- The human approves it on the phone — same approvals pipeline as every
-- other automated write (migration 002).
--
-- Nothing secret lives in this file. The function's auth secret and the
-- project URL are read from Vault AT EACH FIRING (set once, out of band):
--   select vault.create_secret('<secret>', 'weekly_job_secret');
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
-- Rotating either needs no schedule change.
--
-- CI applies every migration to plain Postgres, which has no pg_cron/pg_net/
-- Vault — so the whole schedule is guarded and quietly skips there. On the
-- real project the extensions exist and the schedule lands.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron/pg_net unavailable (plain Postgres) — skipping weekly-insight schedule';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- cron.schedule upserts by job name, so re-running is safe.
  -- timeout is generous: drafting with web search can take a few minutes,
  -- and pg_net's default 5s would kill the request before the model starts.
  perform cron.schedule(
    'weekly-insight-lil-bull',
    '0 13 * * 1',  -- Mondays 13:00 UTC
    $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
             || '/functions/v1/weekly-insight',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' ||
          (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_job_secret')
      ),
      body := '{"venture_slug": "lil-bull"}'::jsonb,
      timeout_milliseconds := 300000
    )
    $job$
  );
end
$$;
