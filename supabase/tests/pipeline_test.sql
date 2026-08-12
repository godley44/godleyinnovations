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
select 'pipeline_test OK: apply, double-apply block, note append, RLS isolation all verified' as result;
