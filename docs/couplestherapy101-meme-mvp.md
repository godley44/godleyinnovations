# CouplesTherapy101 Part 1 — the meme MVP

How a meme gets from Justin's phone to CouplesTherapy101's and Kingdom
Building OS's Instagram/Facebook, with a human hand on every step. Shipped
in bot v0.11.0 with migration 008.

## The flow

1. **Drop** — Justin posts a meme screenshot in **#couplestherapy101** (a
   *high-touch* venture channel: `ventures.interaction_mode = 'high_touch'`).
2. **Read** — the bot downloads the image (Slack `files:read`), mirrors it to
   the public Storage bucket `content-media` at
   `couplestherapy101/<content_item_id>/source.png`, records a
   `content_items` row (deduped on the Slack file id), and answers **in the
   drop's thread**: the joke mechanics in one line, the format (a known
   Imgflip template or "custom edit"), any creator handle visible, and
   *repost or riff?*
3. **Talk it through** — in CouplesTherapy101's voice (`ventures.voice_prompt`).
   Repost: 2–3 captions, each ending `via @handle` (no handle visible → the
   agent asks for the source first). Riff: an Imgflip template, 2–3 text
   sets, a rendered preview posted in the thread, iterate. The thread itself
   is the memory (`conversations.replies`); there is no conversation table.
4. **"Send it"** — the agent calls `file_for_approval`; the bot **does not
   file yet**: it echoes the final package (image, the CT101 caption, the
   KBOS caption, the target list) and asks for *yes*. Only Justin's exact
   *yes* files the `content_calendar` row (kind `image`) and its
   `social.post` proposal — through the same `fileSocialDraft` path the
   admin route and the manager use.
5. **Approve** — the Approve/Reject buttons land **in the same thread** (and
   the app inbox shows the image, both captions, and the targets). Approval
   runs `apply_proposal()` exactly like every other proposal.
6. **Publish** — the poller's publish step fans out: for the source venture
   *and* each `venture_cross_publish` target (CT101 → KBOS for memes), for
   each platform the venture has an enabled `venture_platforms` row for
   (Instagram, Facebook): upload the media to Blotato **with that venture's
   own key**, then post. One `social_publishes` row per (post, venture,
   platform); targets are attempted independently; no automatic retries;
   the per-target results are posted back into the thread and roll up into
   `content_calendar.status` / `content_items.status`.

Kingdom Building OS's caption is CT101's caption; on every 3rd *published*
KBOS post ((published count + 1) divisible by 3) the agent is required to
add a fresh one-line invitation to check out @CouplesTherapy101.

Nothing publishes without the approval gate. The agent never publishes; it
files a proposal, and only after Justin's explicit confirmation.

## Dry-run end-to-end test (no real Blotato key needed)

Dry run is per venture: a venture whose `BLOTATO_API_KEY__<SLUG>` is unset
or the literal `pending` logs the exact requests it *would* send and sends
nothing. With both memes ventures in dry run the whole chain can be
verified from Slack alone.

1. In Slack: create the public channel **#couplestherapy101** (the name must
   equal the venture slug) and `/invite` the bot. Make sure the app has the
   **`files:read`** scope (OAuth & Permissions → add → Reinstall) — without
   it step 3 answers with exactly that instruction.
2. Drop a meme screenshot (PNG/JPG) in #couplestherapy101 as Justin
   (`OWNER_SLACK_USER_ID`).
3. Expected within seconds, **in the drop's thread**: one message with the
   joke read, the format, the handle (or "no handle visible"), and
   *repost or riff?*
4. Reply `repost`. Expected: 2–3 captions ending `via @handle` (or a request
   for the source if none was visible — answer with the handle).
5. Reply `send it` (or `queue it` / `ship it`). Expected: the package echo —
   the image, *CouplesTherapy101 → Instagram, Facebook* with its caption,
   *Kingdom Building OS → Instagram, Facebook* with its caption — and
   "Reply *yes* to file it for approval".
6. Reply `yes`. Expected: "✅ Filed for approval — proposal `<id>`" plus a
   "🧪 Dry run for: couplestherapy101, kingdom-building-os" line.
7. Within a minute: the **Approval needed — CouplesTherapy101** message with
   the image, both captions, the target list, and Approve/Reject buttons —
   in the same thread. The Vercel inbox shows the same card.
8. Tap **Approve**. Expected within a minute: "Publish dry run —
   CouplesTherapy101" in the thread with four lines:
   `CouplesTherapy101 · Instagram`, `CouplesTherapy101 · Facebook`,
   `Kingdom Building OS · Instagram`, `Kingdom Building OS · Facebook`, each
   "🧪 dry run (no real key; request logged, nothing sent)".
9. Render logs (or `POST /admin/deliver-now`): for each venture one
   `[blotato] DRY RUN (<slug>: …) — would POST …/media {"url":"…content-media…"}`
   and two `would POST …/posts for instagram|facebook (account
   account-id-not-set)` lines — the Facebook one with
   `"pageId":"page-id-not-set"`. Four `social_publishes` rows in `dry-run`.

When a real key lands: paste it into Doppler, say *sync blotato accounts for
couplestherapy101* in #studio-admin (confirm with *yes*), delete that
venture's `dry-run` ledger rows, and the next cycle publishes for real.

A riff needs `IMGFLIP_USERNAME` / `IMGFLIP_PASSWORD` in Doppler; without
them the agent offers reposts only and says so. Free Imgflip renders carry a
small corner watermark; Imgflip Premium (~$10/month) removes it — Justin's
call later, nothing depends on it. The rendered image is copied into
Storage at filing time, so publishing never depends on Imgflip hosting.

## Restart safety and re-arming

- `content_items.slack_file_id` is unique: a re-delivered Slack event or a
  re-dropped file never starts a second conversation.
- A package waiting for *yes* lives in memory for 10 minutes and fails
  closed on restart (a later *yes* finds nothing and says so).
- `social_publishes` is claim-before-publish per (post, venture, platform);
  `failed` and `dry-run` rows are terminal — delete a row to re-arm that one
  target after fixing the cause.
- A venture with no `venture_platforms` row for a platform gets a `failed`
  row naming the fix (*sync blotato accounts for <slug>*); the other targets
  still publish.

## Phone-only account setup

Type in **#studio-admin**, confirm each with *yes*:

- `sync blotato accounts for couplestherapy101`
- `sync blotato accounts for kingdom-building-os`

Each looks up that venture's connected Instagram and Facebook accounts (and
the Facebook Page) with that venture's own key and writes the ids into
`venture_platforms`. The same runs as
`POST /admin/blotato-accounts/sync {"ventureSlug":"…"}`, and
`GET /admin/blotato-accounts?venture=<slug>` lists what the key sees.
