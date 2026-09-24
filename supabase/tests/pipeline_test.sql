-- Behavioral test of the approvals pipeline against a real Postgres, run by
-- CI after applying every migration. Exists because these migrations are
-- executed by hand in production — this is the only place the SQL runs
-- before it runs on the real database. Every check raises (failing CI)
-- instead of printing, so a regression can't scroll by unnoticed.
\set ON_ERROR_STOP on

-- Simulate how Supabase/PostgREST executes app queries: a non-superuser role
-- (RLS applies) with the JWT claims in a GUC. The grants mirror what hosted
-- Supabase gives the `authenticated` role.
do $$ begin create role app_user nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to app_user;
grant usage on schema auth to app_user;
grant execute on function auth.jwt() to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;

-- The owner email must match is_owner() in migration 001. If that migration
-- changes emails and this line is forgotten, this test fails — which is the
-- correct outcome, not an inconvenience.
select set_config('request.jwt.claims', '{"email":"godleyj5@gmail.com"}', false);
set role app_user;

-- Owner can create a venture; automation files a proposal against it.
insert into ventures (name, slug) values ('Test Venture', 'test-venture');
insert into proposals (venture_id, action, payload, proposed_by)
  select id, 'ledger.add',
         '{"amount_cents": 12345, "category": "sale", "counterparty": "Acme"}'::jsonb,
         'claude'
  from ventures where slug = 'test-venture';

-- Approval writes the ledger row and flips status in one transaction.
select apply_proposal(id) from proposals where status = 'pending';
do $$
declare n int; st text;
begin
  select count(*) into n from money_ledger
    where amount_cents = 12345 and category = 'sale' and counterparty = 'Acme';
  if n <> 1 then raise exception 'apply_proposal did not write the ledger row'; end if;
  select status into st from proposals;
  if st <> 'approved' then raise exception 'proposal status was not flipped (got %)', st; end if;
end $$;

-- Approving twice must fail loudly, never write twice.
do $$
declare pid uuid;
begin
  select id into pid from proposals limit 1;
  begin
    perform apply_proposal(pid);
    raise exception 'double-apply was NOT blocked';
  exception when others then
    if sqlerrm not like '%already approved%' then raise; end if;
  end;
end $$;

-- note.append appends a dated line, never overwrites.
insert into proposals (venture_id, action, payload)
  select id, 'note.append', '{"text": "pipeline test note"}'::jsonb
  from ventures where slug = 'test-venture';
select apply_proposal(id) from proposals where status = 'pending';
do $$
declare v text;
begin
  select notes into v from ventures where slug = 'test-venture';
  if v not like '[____-__-__] pipeline test note' then
    raise exception 'note.append produced unexpected notes: %', v;
  end if;
end $$;

-- social.post: approval flips the matching calendar row proposed→approved in
-- the same transaction.
insert into content_calendar (venture_id, body, platforms, status)
  select id, 'pipeline test post', array['twitter','linkedin'], 'proposed'
  from ventures where slug = 'test-venture';
insert into proposals (venture_id, action, payload, proposed_by)
  select c.venture_id, 'social.post',
         jsonb_build_object('calendar_id', c.id, 'text', c.body, 'platforms', c.platforms),
         'admin'
  from content_calendar c where c.body = 'pipeline test post';
select apply_proposal(id) from proposals where status = 'pending';
do $$
declare st text;
begin
  select status into st from content_calendar where body = 'pipeline test post';
  if st <> 'approved' then
    raise exception 'social.post approval did not flip the calendar row (got %)', st;
  end if;
end $$;

-- A social.post pointing at no proposed calendar row must fail the approval
-- loudly — a half-wired draft can never approve into nothing.
do $$
declare pid uuid;
begin
  insert into proposals (venture_id, action, payload, proposed_by)
    select id, 'social.post', jsonb_build_object('calendar_id', gen_random_uuid()), 'admin'
    from ventures where slug = 'test-venture'
    returning id into pid;
  begin
    perform apply_proposal(pid);
    raise exception 'social.post with a missing calendar row was NOT blocked';
  exception when others then
    if sqlerrm not like '%no matching proposed calendar row%' then raise; end if;
  end;
  -- Clean up so the stray pending proposal can't confuse later checks.
  delete from proposals where id = pid;
end $$;

-- video.script (migration 008): approval is a no-write go signal — the
-- proposal flips, nothing else changes, and the bot's video_jobs ledger
-- admits exactly one job per script.
insert into proposals (venture_id, action, payload, proposed_by)
  select id, 'video.script',
         jsonb_build_object('script', 'pipeline test script', 'title', 'Pipeline test', 'platforms', array['youtube']),
         'video-agent'
  from ventures where slug = 'test-venture';
select apply_proposal(id) from proposals where status = 'pending';
do $$
declare st text; n int;
begin
  select status into st from proposals where action = 'video.script';
  if st <> 'approved' then raise exception 'video.script approval did not flip the proposal (got %)', st; end if;
  select count(*) into n from content_calendar where kind = 'video';
  if n <> 0 then raise exception 'video.script approval must not create calendar rows (found %)', n; end if;
end $$;
insert into video_jobs (venture_id, script_proposal_id)
  select venture_id, id from proposals where action = 'video.script';
do $$
declare vid uuid; pid uuid;
begin
  select venture_id, id into vid, pid from proposals where action = 'video.script';
  begin
    insert into video_jobs (venture_id, script_proposal_id) values (vid, pid);
    raise exception 'a second video_jobs claim for the same script was NOT blocked';
  exception when unique_violation then null;
  end;
end $$;
-- A kind='video' calendar row carries its title.
insert into content_calendar (venture_id, kind, title, body, media_urls, platforms, status)
  select id, 'video', 'Pipeline test video', 'caption', '["https://example.com/v.mp4"]'::jsonb, array['youtube'], 'draft'
  from ventures where slug = 'test-venture';
do $$
declare n int;
begin
  select count(*) into n from content_calendar where kind = 'video' and title = 'Pipeline test video';
  if n <> 1 then raise exception 'kind=video calendar row was not accepted'; end if;
end $$;
-- The public media bucket exists (storage schema is owner-only, so check as
-- the superuser).
reset role;
do $$
declare n int;
begin
  select count(*) into n from storage.buckets where id = 'media' and public;
  if n <> 1 then raise exception 'public media bucket is missing'; end if;
end $$;
select set_config('request.jwt.claims', '{"email":"godleyj5@gmail.com"}', false);
set role app_user;

-- RLS: any other signed-in email sees nothing and writes nothing.
reset role;
select set_config('request.jwt.claims', '{"email":"stranger@example.com"}', false);
set role app_user;
do $$
declare n int;
begin
  select count(*) into n from ventures;
  if n <> 0 then raise exception 'RLS leak: stranger sees % venture(s)', n; end if;
  select count(*) into n from proposals;
  if n <> 0 then raise exception 'RLS leak: stranger sees % proposal(s)', n; end if;
  begin
    insert into ventures (name, slug) values ('Evil Corp', 'evil-corp');
    raise exception 'RLS insert was NOT blocked';
  exception when others then
    if sqlerrm not like '%row-level security%' then raise; end if;
  end;
end $$;

reset role;
select 'pipeline_test OK: apply, double-apply block, note append, social.post flip + guard, video.script + video_jobs claim, RLS isolation all verified' as result;
