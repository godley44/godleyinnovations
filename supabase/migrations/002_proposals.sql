-- ============================================================================
-- Migration 002: the approvals pipeline.
-- Run after 001, once, in the Supabase SQL editor.
--
-- Automation (the AI Mesh Bot's claude persona, via os-ingest) no longer
-- writes to the ledger/tickets/notes directly. It files a PROPOSAL; the
-- owner approves or rejects it from the app. Approval is what actually
-- writes. This keeps a human hand on every number the agents produce.
-- ============================================================================

create table public.proposals (
  id          uuid primary key default gen_random_uuid(),
  venture_id  uuid not null references public.ventures (id) on delete cascade,
  action      text not null check (action in ('ledger.add', 'ticket.add', 'note.append')),
  -- The exact data the automation wants written, held verbatim until a human
  -- decides. It is applied by apply_proposal() below — the payload is never
  -- copied into the app or edited in flight, so what you approve is what
  -- lands.
  payload     jsonb not null,
  proposed_by text not null default 'automation',
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz   -- when a human decided; the decision time is a
                            -- fact of its own, not derivable from status
);
create index proposals_pending_idx on public.proposals (status, created_at);

alter table public.proposals enable row level security;
create policy owner_all on public.proposals
  for all using (public.is_owner()) with check (public.is_owner());

-- Realtime: the app subscribes to changes on this table so a proposal filed
-- from Slack appears on the phone without a refresh. Subscriptions respect
-- RLS, so only the owner receives these events.
alter publication supabase_realtime add table public.proposals;

-- ----------------------------------------------------------------------------
-- apply_proposal: approving IS the write, in one transaction. The apply
-- logic lives here — in the database, next to the data — rather than in the
-- app or the webhook, so there is exactly one implementation and a
-- half-applied approval (row written, status not flipped) cannot happen.
--
-- SECURITY INVOKER on purpose: it runs as whoever calls it, so RLS applies.
-- Automation and strangers can't even see the proposal row (owner-only RLS
-- above), which means only the signed-in owner can ever approve anything.
-- ----------------------------------------------------------------------------
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
  else
    raise exception 'Unknown proposal action "%".', prop.action;
  end if;

  update public.proposals
     set status = 'approved', decided_at = now()
   where id = p_id;
end;
$$;
