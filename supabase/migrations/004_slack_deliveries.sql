-- ============================================================================
-- Migration 004: the Slack delivery ledger.
-- Run after 003, once, in the Supabase SQL editor.
--
-- godley-os-bot posts approved OS reports (today: the Lil Bull Weekly Market
-- Brief, filed by weekly-insight and approved by the owner) into the
-- venture's Slack channel. This table is what makes that safe across bot
-- restarts: the bot CLAIMS a report here (status 'posting') BEFORE calling
-- Slack, then records the outcome. unique(proposal_id) makes the claim
-- atomic and permanent, so a report can never be posted twice — the failure
-- mode of a crash between claim and post is a report that needs attention,
-- never a duplicate in the channel.
--
-- Row lifecycle (written only by the bot, service role):
--   'posting'    claimed; the Slack call is (or was) in flight. A row stuck
--                here means the bot died between claim and post — surfaced
--                by the bot's health probe and /admin/deliver-now, and never
--                retried automatically.
--   'delivered'  posted; message_ts is Slack's message id in the channel.
--   'failed'     terminal, with the reason in error (no channel named after
--                the venture slug, bot not a member, empty payload...).
--                Deliberately not retried: fix the cause, then delete the
--                row to re-arm delivery of that report.
-- ============================================================================

create table public.slack_deliveries (
  id          uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  status      text not null check (status in ('posting', 'delivered', 'failed')),
  channel_id  text,          -- Slack channel id the post targeted
  message_ts  text,          -- Slack message id, set when status='delivered'
  error       text,          -- failure reason, set when status='failed'
  created_at  timestamptz not null default now(),
  unique (proposal_id)       -- the claim: at most one delivery per report, ever
);

-- Owner-only like every other table; the bot writes with the service-role
-- key server-side (same model as os-ingest and the bot's approve/reject
-- path), so RLS here is about keeping other signed-in accounts out.
alter table public.slack_deliveries enable row level security;
create policy owner_all on public.slack_deliveries
  for all using (public.is_owner()) with check (public.is_owner());
