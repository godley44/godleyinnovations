-- ============================================================================
-- Migration 006: the WhatsApp framing pipeline.
-- Run after 005, once, in the Supabase SQL editor.
--
-- When a weekly brief is APPROVED, godley-os-bot reframes it (OpenAI) as a
-- WhatsApp-ready message and files that framed text as a NEW pending
-- proposal — action 'whatsapp.message', proposed_by 'framing-agent' — which
-- rides the exact same approval rails as everything else (Slack buttons or
-- the app inbox). Nothing ever auto-sends to WhatsApp: after approval the
-- bot posts the text to the venture's Slack channel and the owner pastes it
-- into the group by hand.
--
-- Three pieces:
--   1. proposals admits the new action.
--   2. apply_proposal() handles it as a no-database-write: approval itself
--      is the decision of record; the bot's slack_deliveries ledger tracks
--      the Slack hand-off.
--   3. framing_jobs — the claim-before-run ledger that makes framing happen
--      exactly once per approved brief across bot restarts:
--        'running'  claimed; the OpenAI call is (or was) in flight. Stuck
--                   here = the bot died mid-call — surfaced by the health
--                   probe, never retried automatically.
--        'done'     framed proposal filed; framed_proposal_id points at it.
--        'failed'   terminal, reason in error (API failure, timeout, empty
--                   payload). Fix the cause, delete the row, and the next
--                   cycle re-arms. No automatic retries.
-- ============================================================================

-- 1. The action whitelist. Postgres auto-named the inline check from
--    migration 002 as <table>_<column>_check.
alter table public.proposals drop constraint proposals_action_check;
alter table public.proposals add constraint proposals_action_check
  check (action in ('ledger.add', 'ticket.add', 'note.append', 'whatsapp.message'));

-- 2. apply_proposal learns the action. Full replacement of the migration-002
--    function; the only change is the whatsapp.message branch.
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
  else
    raise exception 'Unknown proposal action "%".', prop.action;
  end if;

  update public.proposals
     set status = 'approved', decided_at = now()
   where id = p_id;
end;
$$;

-- 3. The framing ledger — claim-before-run, exactly once per brief, ever.
create table public.framing_jobs (
  id                 uuid primary key default gen_random_uuid(),
  source_proposal_id uuid not null references public.proposals (id) on delete cascade,
  status             text not null check (status in ('running', 'done', 'failed')),
  framed_proposal_id uuid references public.proposals (id) on delete set null,
  error              text,      -- failure reason, set when status='failed'
  created_at         timestamptz not null default now(),
  unique (source_proposal_id)   -- the claim: at most one framing per brief, ever
);

-- Owner-only like every other table; the bot writes with the service-role
-- key server-side (same model as the Slack ledgers).
alter table public.framing_jobs enable row level security;
create policy owner_all on public.framing_jobs
  for all using (public.is_owner()) with check (public.is_owner());
