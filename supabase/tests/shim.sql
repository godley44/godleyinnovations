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
-- Supabase Storage's catalog (migration 008 declares the public 'media'
-- bucket there). Only the columns the migration touches.
create schema if not exists storage;
create table if not exists storage.buckets (
  id     text primary key,
  name   text not null,
  public boolean not null default false
);
