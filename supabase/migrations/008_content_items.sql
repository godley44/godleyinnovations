-- ============================================================================
-- Migration 008: CouplesTherapy101 Part 1 — the meme MVP.
-- Applied by deploy-on-main (supabase db push) after merge; every statement
-- is idempotent so a re-run is a no-op.
--
-- A high-touch venture works differently from Lil Bull: the owner drops a
-- meme screenshot in the venture's Slack channel, godley-os-bot talks it
-- through with him IN THAT THREAD (in the venture's own voice), and only
-- when he says so does the bot file an approval item. Approval (the SAME
-- social.post proposal + apply_proposal() path as every other post) is the
-- only thing that publishes — to the source venture's Instagram/Facebook
-- AND to each cross-publish target venture's, each through that venture's
-- own Blotato key.
--
-- Pieces:
--   1. ventures gains interaction_mode ('hands_off' = the existing agents'
--      workroom behavior; 'high_touch' = the in-thread content agent) and
--      voice_prompt (the venture's voice, prepended to the agent's rules).
--      couplestherapy101 and kingdom-building-os are upserted as high_touch;
--      lil-bull stays hands_off (the default).
--   2. venture_cross_publish — which venture's content also publishes to
--      which other venture, per content type. Seeded CT101 → KBOS for memes
--      and note cards.
--   3. content_items — one row per image the owner drops: provenance (Slack
--      file, thread), the public mirror in Storage, the credit, the Imgflip
--      template for a riff, and the per-venture captions that were filed.
--      This is deliberately NOT a content_calendar row: the calendar is one
--      row per APPROVED-OR-PROPOSED social post; a content item exists from
--      the moment the image lands, through the conversation, and may never
--      become a post at all.
--   4. content_calendar learns image posts (kind 'image'), points back at
--      its content item, and carries the per-venture captions the executor
--      publishes.
--   5. social_publishes becomes per (post, VENTURE, platform): the ledger
--      row records which venture's key/account published, so a cross-
--      published post has one row per target venture per platform. The old
--      unique(calendar_id, platform) is replaced; existing rows are
--      backfilled with their post's venture.
--   6. Instagram + Facebook rows in venture_platforms for the two ventures
--      (blotato_account_id NULL until the owner runs the account sync from
--      #studio-admin — dry runs work before that, real publishes refuse
--      loudly, same as Lil Bull's rows in 007).
--   7. Supabase Storage bucket `content-media` (public read; the bot writes
--      with the service-role key at <venture_slug>/<content_item_id>/<file>).
--      Guarded: plain Postgres in CI has no storage schema, and the bot also
--      creates the bucket on first use if it is missing.
-- ============================================================================

-- 1. ventures: interaction mode + voice.
alter table public.ventures add column if not exists interaction_mode text not null default 'hands_off';
alter table public.ventures drop constraint if exists ventures_interaction_mode_check;
alter table public.ventures add constraint ventures_interaction_mode_check
  check (interaction_mode in ('hands_off', 'high_touch'));
alter table public.ventures add column if not exists voice_prompt text;

-- The two ventures. On conflict the name and mode are enforced; an existing
-- voice_prompt is KEPT (the owner may have tuned it in the OS) and only a
-- null one is seeded. Status is never touched on an existing row.
insert into public.ventures (name, slug, status, interaction_mode, voice_prompt) values
  (
    'CouplesTherapy101',
    'couplestherapy101',
    'active',
    'high_touch',
    $voice$Find the absurdity → uncover the wisdom → point toward hope. A lens, not a checklist — a post may hit one, two, or all three. Dry, warm, self-aware, reverent underneath the joke. Captions are one or two lines; the punchline carries the point — never preachy, never a sermon. The absurdity is always ours, never God's. Reference standard: a dramatic scene met with a deadpan reaction line that lands as both funny and true.$voice$
  ),
  (
    'Kingdom Building OS',
    'kingdom-building-os',
    'active',
    'high_touch',
    $voice$Justin's personal account, close-circle audience. Shared CouplesTherapy101 content posts as-is. Every 3rd published post appends a fresh, varied one-line invitation to check out @CouplesTherapy101 — never the same wording twice.$voice$
  )
on conflict (slug) do update
  set name             = excluded.name,
      interaction_mode = excluded.interaction_mode,
      voice_prompt     = coalesce(public.ventures.voice_prompt, excluded.voice_prompt);

-- 2. Cross-publish map: source → target, per content type. Slugs on purpose
--    (the brief's contract, and ventures.slug is unique so the FK holds);
--    the bot still resolves both ends to venture_id before touching
--    anything venture-scoped.
create table if not exists public.venture_cross_publish (
  source_slug  text not null references public.ventures (slug) on delete cascade on update cascade,
  target_slug  text not null references public.ventures (slug) on delete cascade on update cascade,
  content_type text not null check (content_type in ('meme', 'note_card', 'text')),
  created_at   timestamptz not null default now(),
  primary key (source_slug, target_slug, content_type),
  check (source_slug <> target_slug)
);
insert into public.venture_cross_publish (source_slug, target_slug, content_type) values
  ('couplestherapy101', 'kingdom-building-os', 'meme'),
  ('couplestherapy101', 'kingdom-building-os', 'note_card')
on conflict do nothing;

-- 3. Content items: one per dropped image.
create table if not exists public.content_items (
  id                  uuid primary key default gen_random_uuid(),
  venture_id          uuid not null references public.ventures (id) on delete cascade,
  content_type        text not null default 'meme' check (content_type in ('meme', 'note_card', 'text')),
  source_kind         text check (source_kind in ('repost', 'riff', 'original')),  -- null until decided in the thread
  slack_channel_id    text not null,
  slack_thread_ts     text not null,   -- the drop message's ts = the thread the conversation lives in
  slack_file_id       text unique,     -- dedupe: the same Slack file is never two items
  file_name           text,            -- the Slack file's name, for "image 2 of 3 (IMG_0412.png)"
  thread_index        integer not null default 1,  -- "image 2 of 3" in a multi-image drop
  source_image_url    text,            -- Slack private URL — audit only; the bot alone can fetch it
  media_url           text,            -- public mirror in Storage of the dropped image (what a repost publishes)
  render_url          text,            -- public mirror in Storage of the Imgflip render (what a riff publishes)
  source_credit       text,            -- creator handle/watermark, e.g. "@templarpilled"
  imgflip_template_id text,
  captions            jsonb not null default '{}'::jsonb,  -- keyed by target venture slug
  status              text not null default 'open'
                      check (status in ('queued', 'open', 'proposed', 'published', 'partial', 'failed', 'rejected')),
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists content_items_thread_idx on public.content_items (slack_channel_id, slack_thread_ts);

-- 4. Calendar rows learn image posts and their provenance.
alter table public.content_calendar drop constraint if exists content_calendar_kind_check;
alter table public.content_calendar add constraint content_calendar_kind_check check (kind in ('text', 'image'));
alter table public.content_calendar add column if not exists content_item_id uuid references public.content_items (id) on delete set null;
alter table public.content_calendar add column if not exists captions jsonb not null default '{}'::jsonb;

-- 5. The publish ledger becomes per (post, venture, platform).
alter table public.social_publishes add column if not exists venture_id uuid references public.ventures (id) on delete cascade;
update public.social_publishes p
   set venture_id = c.venture_id
  from public.content_calendar c
 where c.id = p.calendar_id
   and p.venture_id is null;
alter table public.social_publishes alter column venture_id set not null;
alter table public.social_publishes drop constraint if exists social_publishes_calendar_id_platform_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'social_publishes_calendar_venture_platform_key') then
    alter table public.social_publishes
      add constraint social_publishes_calendar_venture_platform_key unique (calendar_id, venture_id, platform);
  end if;
end $$;

-- 6. Instagram + Facebook for the two ventures; account ids arrive via the
--    owner's "sync blotato accounts for <slug>" in #studio-admin.
insert into public.venture_platforms (venture_id, platform)
select v.id, p.platform
  from public.ventures v, (values ('instagram'), ('facebook')) as p(platform)
 where v.slug in ('couplestherapy101', 'kingdom-building-os')
on conflict (venture_id, platform) do nothing;

-- Owner-only like every other table; the bot writes with the service-role
-- key server-side. drop-then-create keeps the policies idempotent.
alter table public.venture_cross_publish enable row level security;
drop policy if exists owner_all on public.venture_cross_publish;
create policy owner_all on public.venture_cross_publish
  for all using (public.is_owner()) with check (public.is_owner());
alter table public.content_items enable row level security;
drop policy if exists owner_all on public.content_items;
create policy owner_all on public.content_items
  for all using (public.is_owner()) with check (public.is_owner());

-- 7. The public-read media bucket. Public read is what lets Blotato (and
--    the model, for the in-thread conversation) fetch the image by URL; only
--    the bot's service-role key can write. Skipped on plain Postgres.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('content-media', 'content-media', true)
    on conflict (id) do update set public = true;
  else
    raise notice 'storage schema unavailable (plain Postgres) — skipping the content-media bucket';
  end if;
end $$;
