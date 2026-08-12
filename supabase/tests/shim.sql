-- Shims so the repo's migrations run on vanilla Postgres in CI. These stand
-- in for the two pieces hosted Supabase provides out of the box:
--   auth.jwt()          — reads the same per-request GUC Supabase sets
--   supabase_realtime   — the publication migrations add tables to
-- CI runs: shim.sql -> every migration in order -> pipeline_test.sql.
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create publication supabase_realtime;
