-- ============================================================================
-- Migration 001: the core of the Godley Innovations OS.
-- Run this by hand in the Supabase SQL editor (Dashboard -> SQL Editor ->
-- paste -> Run). Migrations are numbered; run them in order, once each.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- OWNERSHIP. This is a single-operator system. Rather than build roles and
-- sharing we lock every table to one email address. Anyone else who signs up
-- through the public auth endpoint gets an account but can read/write nothing.
-- The email lives in exactly one place: this function. To transfer or add an
-- owner later, replace this function -- no policy needs to change.
-- ----------------------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'godleyj5@gmail.com'
$$;

-- ----------------------------------------------------------------------------
-- VENTURES. The registry. Every other table hangs off a venture. A venture's
-- "folder" in the app is just its row here plus everything that references it.
-- Status is stored (it is a decision, not derivable); everything like "how
-- much cash does this venture have" is NOT stored -- it is computed from the
-- ledger below, so it can never disagree with the ledger.
-- ----------------------------------------------------------------------------
create table public.ventures (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique check (slug ~ '^[a-z0-9-]+$'),
  status     text not null default 'idea'
             check (status in ('idea', 'active', 'paused', 'dead')),
  thesis     text,          -- one line: what this venture is and why it exists
  notes      text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- MONEY LEDGER. One table for every dollar in or out, across all modules.
-- This looks wrong at first: "where is the sales table? where is ad spend?"
-- They are HERE, as categories. The Sales tab is a lens on category='sale';
-- the Advertising tab derives spend from category='advertising'. One source
-- of truth means a sale recorded in Sales and cash flow shown in Financials
-- can never disagree, because they are the same row.
-- Amounts are integer cents (positive = money in, negative = money out)
-- because floating-point money drifts and bigint cents never does.
-- ----------------------------------------------------------------------------
create table public.money_ledger (
  id           uuid primary key default gen_random_uuid(),
  venture_id   uuid not null references public.ventures (id) on delete cascade,
  occurred_on  date not null default current_date,
  amount_cents bigint not null,
  category     text not null check (category in (
                 'sale',         -- revenue; the Sales tab is this category
                 'advertising',  -- ad spend; the Advertising tab derives from it
                 'operations',   -- rent, software, fuel, day-to-day costs
                 'equipment',    -- one-off purchases (vehicles, hardware)
                 'fees',         -- platform fees, bank fees, licenses
                 'funding',      -- money you put in or raised
                 'other'
               )),
  counterparty text,  -- who paid you / who you paid (customer, vendor)
  item         text,  -- what was bought or sold
  note         text,
  created_at   timestamptz not null default now()
);
create index money_ledger_venture_idx on public.money_ledger (venture_id, occurred_on);

-- ----------------------------------------------------------------------------
-- SOCIAL. Accounts are facts (this venture has this handle on this platform).
-- Follower counts change over time, so they are snapshots, not a column on
-- the account -- a single "followers" column would silently go stale and lie.
-- Growth is derived by comparing snapshots.
-- Snapshots reference the account, not the venture: the venture is reachable
-- through the account, and storing it twice would let the two disagree.
-- ----------------------------------------------------------------------------
create table public.social_accounts (
  id         uuid primary key default gen_random_uuid(),
  venture_id uuid not null references public.ventures (id) on delete cascade,
  platform   text not null check (platform in (
               'youtube', 'instagram', 'tiktok', 'x', 'facebook',
               'linkedin', 'twitch', 'other'
             )),
  handle     text not null,
  url        text,
  created_at timestamptz not null default now()
);

create table public.social_snapshots (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.social_accounts (id) on delete cascade,
  taken_on       date not null default current_date,
  follower_count integer not null check (follower_count >= 0),
  note           text,
  created_at     timestamptz not null default now()
);
create index social_snapshots_account_idx on public.social_snapshots (account_id, taken_on);

-- ----------------------------------------------------------------------------
-- WEBSITES. Domains and sites per venture. renewal_on is stored because it is
-- a fact from the registrar, not derivable; "days until renewal" is derived
-- in the app from it.
-- ----------------------------------------------------------------------------
create table public.websites (
  id         uuid primary key default gen_random_uuid(),
  venture_id uuid not null references public.ventures (id) on delete cascade,
  label      text not null,   -- e.g. "main site", "shop"
  url        text not null,
  host       text,            -- where it runs / who the registrar is
  status     text not null default 'building'
             check (status in ('live', 'building', 'down', 'retired')),
  renewal_on date,            -- next domain/hosting renewal date
  note       text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- SUPPORT TICKETS. "How long has this been open" is derived from opened_on;
-- there is deliberately no closed_on column to keep in sync -- when you close
-- a ticket you set status and write the resolution, and that is the record.
-- ----------------------------------------------------------------------------
create table public.support_tickets (
  id         uuid primary key default gen_random_uuid(),
  venture_id uuid not null references public.ventures (id) on delete cascade,
  opened_on  date not null default current_date,
  customer   text,
  channel    text,            -- where it came in: email, IG DM, phone...
  subject    text not null,
  status     text not null default 'open'
             check (status in ('open', 'waiting', 'closed')),
  resolution text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- AD CAMPAIGNS. Metadata only. There is no "spend" column on purpose: actual
-- ad dollars are ledger rows (category='advertising'), so spend is derived
-- and can never disagree with the books. Likewise there is no status column:
-- upcoming/running/ended is derived from the dates.
-- ----------------------------------------------------------------------------
create table public.ad_campaigns (
  id           uuid primary key default gen_random_uuid(),
  venture_id   uuid not null references public.ventures (id) on delete cascade,
  name         text not null,
  platform     text not null,  -- free text: "Meta", "Google", "flyers"...
  starts_on    date not null default current_date,
  ends_on      date,           -- null = open-ended
  budget_cents bigint,         -- planned budget; actual spend lives in the ledger
  note         text,
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY. The anon key ships in the browser bundle by design
-- (that is how Supabase works); these policies are the actual lock. Every
-- table: full access for the owner, nothing for anyone else.
-- ----------------------------------------------------------------------------
alter table public.ventures         enable row level security;
alter table public.money_ledger     enable row level security;
alter table public.social_accounts  enable row level security;
alter table public.social_snapshots enable row level security;
alter table public.websites         enable row level security;
alter table public.support_tickets  enable row level security;
alter table public.ad_campaigns     enable row level security;

create policy owner_all on public.ventures         for all using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.money_ledger     for all using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.social_accounts  for all using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.social_snapshots for all using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.websites         for all using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.support_tickets  for all using (public.is_owner()) with check (public.is_owner());
create policy owner_all on public.ad_campaigns     for all using (public.is_owner()) with check (public.is_owner());
