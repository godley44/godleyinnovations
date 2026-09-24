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
  select count(*) into n from storage.buckets where id = 'content-media' and public;
  if n <> 1 then raise exception 'public content-media bucket (migration 009) is missing'; end if;
end $$;
select set_config('request.jwt.claims', '{"email":"godleyj5@gmail.com"}', false);
set role app_user;
-- Migration 009: high-touch ventures, the cross-publish map, content items,
-- image posts, and the per-venture publish ledger.
do $$
declare n int; mode text;
begin
  select count(*) into n from ventures where slug in ('couplestherapy101', 'kingdom-building-os') and interaction_mode = 'high_touch';
  if n <> 2 then raise exception 'expected both meme ventures upserted as high_touch, found %', n; end if;
  select interaction_mode into mode from ventures where slug = 'test-venture';
  if mode <> 'hands_off' then raise exception 'a venture created without a mode must default to hands_off (got %)', mode; end if;
  select count(*) into n from ventures where slug in ('couplestherapy101', 'kingdom-building-os') and voice_prompt is not null;
  if n <> 2 then raise exception 'voice_prompt was not seeded for both ventures'; end if;
  select count(*) into n from venture_cross_publish where source_slug = 'couplestherapy101' and target_slug = 'kingdom-building-os';
  if n <> 2 then raise exception 'expected 2 cross-publish rows (meme, note_card), found %', n; end if;
  select count(*) into n from venture_platforms vp join ventures v on v.id = vp.venture_id
    where v.slug in ('couplestherapy101', 'kingdom-building-os') and vp.platform in ('instagram', 'facebook');
  if n <> 4 then raise exception 'expected instagram+facebook rows for both ventures, found %', n; end if;
end $$;

-- A content item turns into an image post that carries its captions; the
-- same social.post approval flips it, exactly like a text post.
insert into content_items (venture_id, slack_channel_id, slack_thread_ts, slack_file_id, media_url, source_credit)
  select id, 'C_CT101', '1727.000100', 'F_TEST_1', 'https://example.test/content-media/ct101/x/meme.png', '@templarpilled'
  from ventures where slug = 'couplestherapy101';
insert into content_calendar (venture_id, kind, body, media_urls, platforms, status, content_item_id, captions)
  select v.id, 'image', 'CT101 caption via @templarpilled', '["https://example.test/content-media/ct101/x/meme.png"]'::jsonb,
         array['instagram','facebook'], 'proposed', ci.id,
         '{"couplestherapy101": "CT101 caption via @templarpilled", "kingdom-building-os": "CT101 caption via @templarpilled"}'::jsonb
  from ventures v join content_items ci on ci.venture_id = v.id
  where v.slug = 'couplestherapy101' and ci.slack_file_id = 'F_TEST_1';
insert into proposals (venture_id, action, payload, proposed_by)
  select c.venture_id, 'social.post',
         jsonb_build_object('calendar_id', c.id, 'text', c.body, 'platforms', c.platforms, 'contentItemId', c.content_item_id),
         'content-agent'
  from content_calendar c where c.kind = 'image';
select apply_proposal(id) from proposals where status = 'pending';
do $$
declare st text;
begin
  select status into st from content_calendar where kind = 'image';
  if st <> 'approved' then raise exception 'social.post approval did not flip the image post (got %)', st; end if;
end $$;

-- The publish ledger is per (post, venture, platform): the cross-published
-- post has one instagram row per target venture, and a duplicate for the
-- same venture is refused.
insert into social_publishes (calendar_id, venture_id, platform, status)
  select c.id, v.id, 'instagram', 'dry-run'
  from content_calendar c, ventures v
  where c.kind = 'image' and v.slug in ('couplestherapy101', 'kingdom-building-os');
do $$
declare n int; cal uuid; kb uuid;
begin
  select count(*) into n from social_publishes where platform = 'instagram';
  if n <> 2 then raise exception 'expected one instagram ledger row per target venture, found %', n; end if;
  select id into cal from content_calendar where kind = 'image';
  select id into kb from ventures where slug = 'kingdom-building-os';
  begin
    insert into social_publishes (calendar_id, venture_id, platform, status) values (cal, kb, 'instagram', 'publishing');
    raise exception 'duplicate (post, venture, platform) ledger row was NOT blocked';
  exception when unique_violation then null;
  end;
  begin
    insert into social_publishes (calendar_id, platform, status) values (cal, 'facebook', 'publishing');
    raise exception 'a ledger row without venture_id was NOT blocked';
  exception when not_null_violation then null;
  end;
end $$;

-- The same Slack file can never become two content items.
do $$
begin
  insert into content_items (venture_id, slack_channel_id, slack_thread_ts, slack_file_id)
    select id, 'C_CT101', '1727.000200', 'F_TEST_1' from ventures where slug = 'couplestherapy101';
  raise exception 'duplicate slack_file_id was NOT blocked';
exception when unique_violation then null;
end $$;

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
select 'pipeline_test OK: apply, double-apply block, note append, social.post flip + guard, content items + per-venture ledger (008), RLS isolation all verified' as result;
