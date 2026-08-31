-- ============================================================================
-- Migration 007: the content calendar and social publishing pipeline.
-- Run after 006, once, in the Supabase SQL editor.
--
-- Social posts become OS objects: drafted into content_calendar (via the
-- bot's /admin/social-draft route this phase), approved through the SAME
-- proposal rails as everything else (action 'social.post'), then published
-- by godley-os-bot to the venture's platform stack via Blotato. The approval
-- gate is the ONLY path to publishing — scheduled_for below is informational
-- and nothing auto-publishes on a schedule in this phase.
--
-- Four pieces:
--   1. proposals admits 'social.post'; apply_proposal() gains its branch:
--      approving flips the matching calendar row proposed→approved in the
--      same transaction (raising if there is no such row — a half-wired
--      draft must fail the approval loudly, not approve into nothing).
--   2. content_calendar — one row per social post, venture-scoped.
--   3. venture_platforms — each venture's platform stack. Posts can NEVER
--      cross ventures: the bot resolves Blotato account ids only through
--      this table for the post's venture_id. Seeded for lil-bull with
--      blotato_account_id NULL — the ids are born when the real Blotato key
--      is generated (which starts billing), fetched via the bot's
--      GET /admin/blotato-accounts, and assigned by hand in the SQL editor.
--      Publishing refuses loudly per-platform while the id is NULL.
--   4. social_publishes — the per-platform publish ledger, claim-before-
--      publish ('publishing' → 'submitted' → 'published'/'failed', or
--      'dry-run' while no real key exists), unique(calendar_id, platform),
--      terminal failures with the reason recorded (Blotato's own docs:
--      "do not retry on failed — most failures are permanent"), delete-the-
--      row-to-re-arm one platform. Same restart safety as 004/005/006.
-- ============================================================================

-- 1a. The action whitelist. Postgres auto-named the inline check from
--     migration 002 as <table>_<column>_check.
alter table public.proposals drop constraint proposals_action_check;
alter table public.proposals add constraint proposals_action_check
  check (action in ('ledger.add', 'ticket.add', 'note.append', 'whatsapp.message', 'social.post'));

-- 2. The calendar: one row per social post, venture-scoped.
create table public.content_calendar (
  id                 uuid primary key default gen_random_uuid(),
  venture_id         uuid not null references public.ventures (id) on delete cascade,
  kind               text not null default 'text' check (kind in ('text')),  -- video later
  body               text not null,
  media_urls         jsonb not null default '[]'::jsonb,   -- public URLs; [] = text-only
  platforms          text[] not null,                      -- target subset of the venture's stack
  scheduled_for      timestamptz,   -- informational ONLY this phase; nothing auto-publishes
  status             text not null default 'draft'
                     check (status in ('draft','proposed','approved','publishing','published','partial','failed','rejected')),
  source_proposal_id uuid references public.proposals (id) on delete set null,  -- e.g. the brief it derives from
  proposal_id        uuid references public.proposals (id) on delete set null,  -- its social.post approval
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 3. Per-venture platform stacks. Posts can NEVER cross ventures: the
--    publish step resolves accounts only through this table for the post's
--    venture_id.
create table public.venture_platforms (
  id                 uuid primary key default gen_random_uuid(),
  venture_id         uuid not null references public.ventures (id) on delete cascade,
  platform           text not null check (platform in
                       ('twitter','linkedin','youtube','facebook','instagram','tiktok','pinterest','threads','bluesky')),
  blotato_account_id text,   -- NULL until the real key exists; publish refuses loudly while NULL
  blotato_page_id    text,   -- LinkedIn company page id; NULL = personal profile
  youtube_privacy    text check (youtube_privacy in ('private','public','unlisted')),
  enabled            boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (venture_id, platform)
);
insert into public.venture_platforms (venture_id, platform, youtube_privacy)
select v.id, p.platform, case when p.platform = 'youtube' then 'public' end
from public.ventures v, (values ('twitter'),('linkedin'),('youtube')) as p(platform)
where v.slug = 'lil-bull';

-- 4. The per-platform publish ledger — claim-before-publish, one row per
--    (post, platform), ever.
create table public.social_publishes (
  id            uuid primary key default gen_random_uuid(),
  calendar_id   uuid not null references public.content_calendar (id) on delete cascade,
  platform      text not null,
  status        text not null check (status in ('publishing','submitted','published','failed','dry-run')),
  submission_id text,   -- Blotato postSubmissionId
  public_url    text,
  error         text,   -- terminal reason; Blotato itself says "do not retry on failed"
  created_at    timestamptz not null default now(),
  unique (calendar_id, platform)
);

-- Owner-only like every other table; the bot writes with the service-role
-- key server-side (same model as the Slack ledgers).
alter table public.content_calendar enable row level security;
create policy owner_all on public.content_calendar
  for all using (public.is_owner()) with check (public.is_owner());
alter table public.venture_platforms enable row level security;
create policy owner_all on public.venture_platforms
  for all using (public.is_owner()) with check (public.is_owner());
alter table public.social_publishes enable row level security;
create policy owner_all on public.social_publishes
  for all using (public.is_owner()) with check (public.is_owner());

-- 1b. apply_proposal learns the action. Full replacement of the migration-006
--     function; the only change is the social.post branch.
create or replace function public.apply_proposal(p_id uuid)
returns void
language plpgsql
as $$
declare
  prop      public.proposals%rowtype;
  note_line text;
begin
  select * into prop from public.proposals where id = p_id for update;
  if not found then
    raise exception 'Proposal not found (or you are not the owner).';
  end if;
  if prop.status <> 'pending' then
    raise exception 'This proposal was already %.', prop.status;
  end if;

  if prop.action = 'ledger.add' then
    insert into public.money_ledger
      (venture_id, amount_cents, category, occurred_on, counterparty, item, note)
    values (
      prop.venture_id,
      (prop.payload->>'amount_cents')::bigint,
      coalesce(prop.payload->>'category', 'other'),
      coalesce((prop.payload->>'occurred_on')::date, current_date),
      nullif(prop.payload->>'counterparty', ''),
      nullif(prop.payload->>'item', ''),
      nullif(prop.payload->>'note', '')
    );
  elsif prop.action = 'ticket.add' then
    insert into public.support_tickets
      (venture_id, subject, customer, channel, opened_on)
    values (
      prop.venture_id,
      prop.payload->>'subject',
      nullif(prop.payload->>'customer', ''),
      nullif(prop.payload->>'channel', ''),
      coalesce((prop.payload->>'opened_on')::date, current_date)
    );
  elsif prop.action = 'note.append' then
    -- Append-only, dated: automation can add to the owner's notes but can
    -- never rewrite or erase them.
    note_line := '[' || to_char(now(), 'YYYY-MM-DD') || '] ' || (prop.payload->>'text');
    update public.ventures
       set notes = case when notes is null or notes = ''
                        then note_line
                        else notes || E'\n' || note_line end
     where id = prop.venture_id;
  elsif prop.action = 'whatsapp.message' then
    -- No database write: approving IS the record. The bot's delivery ledger
    -- (slack_deliveries) tracks the Slack hand-off, and the final hop into
    -- WhatsApp is always the owner pasting by hand.
    null;
  elsif prop.action = 'social.post' then
    -- Approving IS the go signal: flip the calendar row in the same
    -- transaction. Everything after (claiming, Blotato, per-platform
    -- outcomes) belongs to the bot's social_publishes ledger.
    update public.content_calendar
       set status = 'approved', updated_at = now()
     where id = (prop.payload->>'calendar_id')::uuid
       and status = 'proposed';
    if not found then
      raise exception 'social.post proposal has no matching proposed calendar row';
    end if;
  else
    raise exception 'Unknown proposal action "%".', prop.action;
  end if;

  update public.proposals
     set status = 'approved', decided_at = now()
   where id = p_id;
end;
$$;
