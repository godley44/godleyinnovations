-- ============================================================================
-- Migration 008: the voice-first video pipeline.
-- Applied by deploy-on-main (supabase db push) after the PR merges. Idempotent.
--
-- Approved text becomes a narrated video in the owner's cloned voice, then
-- rides the EXISTING approval gate to publish. Two approvals, in order, so no
-- money is spent before a human says so:
--
--   1. 'video.script' — the framing agent's spoken script. Approving it is
--      the go signal for the bot's video_jobs ledger (ElevenLabs narration →
--      Pictory assembly → public video in Storage). No database write here:
--      like whatsapp.message, approving IS the record.
--   2. 'social.post' with a kind='video' calendar row — the finished video,
--      with a preview link so the owner can WATCH it before approving. The
--      existing apply_proposal branch flips the calendar row; the existing
--      publish step sends it to YouTube (+ Instagram once connected) via
--      Blotato. Nothing publishes without this second approval.
--
-- Pieces:
--   1. proposals admits 'video.script'; apply_proposal() gains its (no-write)
--      branch.
--   2. content_calendar.kind admits 'video'; a nullable title column carries
--      the YouTube title (Blotato requires one per video post).
--   3. ventures gains elevenlabs_voice_id (the venture's cloned voice; NULL =
--      the bot resolves the account's single cloned voice on first use and
--      records it here) and video_cta (the spoken call-to-action every script
--      ends with).
--   4. video_jobs — the per-script ledger, claim-before-run, one row per
--      approved script ever (unique(script_proposal_id)):
--        scripted → narrated → assembling → assembled → proposed
--                                                    ↘ failed (terminal, reason)
--                                                    ↘ dry-run (terminal; VIDEO_DRY_RUN=1)
--      Every stage transition is persisted, so a bot restart resumes from the
--      last completed stage; a terminal row is re-armed by deleting it (same
--      discipline as 004/005/006/007).
--   5. venture_platforms: an instagram row for lil-bull, DISABLED until the
--      account is connected in Blotato (enable it + set blotato_account_id by
--      hand then). Publishing refuses loudly while disabled.
--   6. A PUBLIC storage bucket 'media' for the rendered audio/video: Blotato
--      and Pictory fetch media by public URL. Paths are video/<job-id>/…;
--      nothing secret is ever written there.
-- ============================================================================

-- 1a. The action whitelist.
alter table public.proposals drop constraint if exists proposals_action_check;
alter table public.proposals add constraint proposals_action_check
  check (action in ('ledger.add', 'ticket.add', 'note.append', 'whatsapp.message', 'social.post', 'video.script'));

-- 2. Video posts in the calendar.
alter table public.content_calendar drop constraint if exists content_calendar_kind_check;
alter table public.content_calendar add constraint content_calendar_kind_check
  check (kind in ('text', 'video'));
alter table public.content_calendar add column if not exists title text;  -- YouTube title; NULL for text posts

-- 3. The venture's voice and call-to-action.
alter table public.ventures add column if not exists elevenlabs_voice_id text;
alter table public.ventures add column if not exists video_cta text;
update public.ventures
   set video_cta = 'Follow Lil Bull for next week''s brief.'
 where slug = 'lil-bull' and video_cta is null;

-- 4. The video ledger.
create table if not exists public.video_jobs (
  id                      uuid primary key default gen_random_uuid(),
  venture_id              uuid not null references public.ventures (id) on delete cascade,
  script_proposal_id      uuid not null unique references public.proposals (id) on delete cascade,
  stage                   text not null default 'scripted'
                          check (stage in ('scripted','narrated','assembling','assembled','proposed','failed','dry-run')),
  audio_url               text,   -- public Storage URL of the ElevenLabs narration
  audio_seconds           numeric,
  pictory_storyboard_job  text,   -- Pictory storyboard-preview job id
  pictory_render_job      text,   -- Pictory render job id
  video_url               text,   -- public Storage URL of the final MP4
  video_seconds           numeric,
  calendar_id             uuid references public.content_calendar (id) on delete set null,  -- the kind='video' row it proposed
  error                   text,   -- terminal reason (stage = failed)
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
alter table public.video_jobs enable row level security;
do $$ begin
  create policy owner_all on public.video_jobs
    for all using (public.is_owner()) with check (public.is_owner());
exception when duplicate_object then null; end $$;

-- 5. Instagram, present but off until connected.
insert into public.venture_platforms (venture_id, platform, enabled)
select v.id, 'instagram', false
from public.ventures v
where v.slug = 'lil-bull'
on conflict (venture_id, platform) do nothing;

-- 6. The public media bucket (Supabase Storage; the CI shim provides the
--    storage.buckets table on vanilla Postgres).
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;

-- 1b. apply_proposal learns the action. Full replacement of the migration-007
--     function; the only change is the video.script branch.
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
  elsif prop.action = 'video.script' then
    -- No database write: approving IS the go signal. The bot's video_jobs
    -- ledger claims the approved script (one job per script, ever), spends
    -- the narration and assembly minutes, and files the finished video as a
    -- NEW social.post proposal — which needs its own approval to publish.
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
