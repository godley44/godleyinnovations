-- ============================================================================
-- Migration 005: the Slack approval-prompt ledger.
-- Run after 004, once, in the Supabase SQL editor.
--
-- godley-os-bot posts PENDING proposals to the venture's Slack channel with
-- Approve/Reject buttons (the trigger for the interactions route, which
-- calls apply_proposal). This table makes that safe and honest:
--  - the bot CLAIMS a proposal here (status 'posting') BEFORE posting, and
--    unique(proposal_id) makes the claim atomic — no duplicate buttons
--    messages across restarts;
--  - message_ts is kept so the message can be re-rendered later via
--    chat.update when the proposal is decided somewhere else (the app's
--    inbox) — buttons must never stay live for a decided proposal.
--
-- This is deliberately a SEPARATE table from slack_deliveries (004): a
-- weekly-insight proposal legitimately has BOTH a buttons prompt (pending)
-- and a brief delivery (after approval), which unique(proposal_id) in one
-- shared table would forbid — and the two message kinds have different
-- lifecycles (a delivery is immutable once posted; a prompt gets disarmed).
--
-- Row lifecycle (written only by the bot, service role):
--   'posting'   claimed; the Slack post is (or was) in flight. Stuck here =
--               the bot died between claim and post — surfaced by the
--               health probe, never retried automatically.
--   'posted'    buttons are live in the channel; message_ts recorded.
--   'disarmed'  the proposal was decided (via the buttons or the app) and
--               the message re-rendered to say the outcome; disarmed_at set.
--   'failed'    terminal, reason in error (no channel named after the
--               venture slug, bot not a member...). Fix the cause, delete
--               the row, and the next cycle re-arms.
-- ============================================================================

create table public.slack_prompts (
  id          uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  status      text not null check (status in ('posting', 'posted', 'disarmed', 'failed')),
  channel_id  text,          -- Slack channel id the prompt targeted
  message_ts  text,          -- Slack message id, needed later for chat.update
  error       text,          -- failure reason, set when status='failed'
  created_at  timestamptz not null default now(),
  disarmed_at timestamptz,   -- when the buttons were retired
  unique (proposal_id)       -- the claim: at most one prompt per proposal, ever
);

-- Owner-only like every other table; the bot writes with the service-role
-- key server-side (same model as slack_deliveries).
alter table public.slack_prompts enable row level security;
create policy owner_all on public.slack_prompts
  for all using (public.is_owner()) with check (public.is_owner());
