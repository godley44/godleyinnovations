// Tests for the Blotato client: per-platform request builders against the
// DOCUMENTED schema (help.blotato.com/api/publish-post), request
// construction against a mocked fetch (CI never hits the API), the dry-run
// path, per-venture key resolution, and key hygiene. Each test file runs in
// its own process under `node --test`, so env/fetch swaps cannot leak
// between suites.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  buildPublishRequest,
  dryRunReason,
  getPostStatus,
  isDryRun,
  listAccounts,
  listSubaccounts,
  publishPost,
  resolveBlotatoKey,
  uploadMedia,
  ventureKeyName,
} from "./blotato.js";

// Trailing "=" on purpose: Blotato keys carry base64 padding that must
// survive verbatim into the header.
const TEST_KEY = "blot-test-key-not-real==";
const CT101_KEY = "blot-ct101-key-not-real==";

const realFetch = globalThis.fetch;
let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

const ENV_NAMES = [
  "BLOTATO_API_KEY",
  "BLOTATO_DRY_RUN",
  "BLOTATO_API_KEY__COUPLESTHERAPY101",
  "BLOTATO_API_KEY__KINGDOM_BUILDING_OS",
  "BLOTATO_API_KEY__LIL_BULL",
];

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.BLOTATO_API_KEY = TEST_KEY;
  captured = null;
  nextResponse = () => new Response(JSON.stringify({ postSubmissionId: "sub-123" }), { status: 201 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of ENV_NAMES) delete process.env[name];
});

// --- request builders ---------------------------------------------------------

test("twitter request matches the documented schema, text-only allowed", () => {
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  assert.deepEqual(req, {
    post: {
      accountId: "acc-tw",
      content: { text: "hello", mediaUrls: [], platform: "twitter" },
      target: { targetType: "twitter" },
    },
  });
});

test("linkedin request: pageId present only when given (personal profile = omitted)", () => {
  const personal = buildPublishRequest({ platform: "linkedin", accountId: "acc-li", text: "post", mediaUrls: [] });
  assert.deepEqual(personal.post.target, { targetType: "linkedin" });
  assert.ok(!("pageId" in personal.post.target), "omitting pageId targets the personal profile");

  const page = buildPublishRequest({
    platform: "linkedin",
    accountId: "acc-li",
    text: "post",
    mediaUrls: [],
    linkedinPageId: "page-9",
  });
  assert.deepEqual(page.post.target, { targetType: "linkedin", pageId: "page-9" });
});

test("instagram request: documented target is targetType only; media is mandatory", () => {
  const req = buildPublishRequest({
    platform: "instagram",
    accountId: "acc-ig",
    text: "caption via @handle",
    mediaUrls: ["https://database.blotato.io/meme.png"],
  });
  assert.deepEqual(req, {
    post: {
      accountId: "acc-ig",
      content: { text: "caption via @handle", mediaUrls: ["https://database.blotato.io/meme.png"], platform: "instagram" },
      target: { targetType: "instagram" },
    },
  });
  assert.throws(
    () => buildPublishRequest({ platform: "instagram", accountId: "acc-ig", text: "caption", mediaUrls: [] }),
    /text-only posts cannot publish to Instagram/,
  );
});

test("facebook request: pageId is a required target field — refused before any network call without it", () => {
  const req = buildPublishRequest({
    platform: "facebook",
    accountId: "acc-fb",
    text: "caption",
    mediaUrls: ["https://database.blotato.io/meme.png"],
    facebookPageId: "page-123",
  });
  assert.deepEqual(req.post.target, { targetType: "facebook", pageId: "page-123" });
  assert.equal(req.post.content.platform, "facebook");
  assert.throws(
    () => buildPublishRequest({ platform: "facebook", accountId: "acc-fb", text: "caption", mediaUrls: ["https://x/y.png"] }),
    /Page id is required/,
  );
});

test("youtube request carries the documented required flags", () => {
  const req = buildPublishRequest({
    platform: "youtube",
    accountId: "acc-yt",
    text: "video description",
    mediaUrls: ["https://example.com/video.mp4"],
    youtube: { title: "Weekly Brief", privacyStatus: "public", shouldNotifySubscribers: false },
  });
  assert.deepEqual(req.post.target, {
    targetType: "youtube",
    title: "Weekly Brief",
    privacyStatus: "public",
    shouldNotifySubscribers: false,
    // The narration is an AI-cloned voice: the disclosure is always on.
    containsSyntheticMedia: true,
  });
  assert.equal(req.post.content.platform, "youtube");
});

test("youtube refuses text-only posts and missing title before any network call", () => {
  assert.throws(
    () =>
      buildPublishRequest({
        platform: "youtube",
        accountId: "acc-yt",
        text: "desc",
        mediaUrls: [],
        youtube: { title: "t", privacyStatus: "public", shouldNotifySubscribers: false },
      }),
    /text-only posts cannot publish to YouTube/,
  );
  assert.throws(
    () =>
      buildPublishRequest({
        platform: "youtube",
        accountId: "acc-yt",
        text: "desc",
        mediaUrls: ["https://example.com/v.mp4"],
      }),
    /title and privacy settings are required/,
  );
});

test("missing accountId fails the build, not the publish", () => {
  assert.throws(
    () => buildPublishRequest({ platform: "twitter", accountId: "", text: "x", mediaUrls: [] }),
    /accountId is not configured/,
  );
});

// --- key resolution -----------------------------------------------------------

test("key names: slug → BLOTATO_API_KEY__SLUG_UPPER_SNAKE", () => {
  assert.equal(ventureKeyName("couplestherapy101"), "BLOTATO_API_KEY__COUPLESTHERAPY101");
  assert.equal(ventureKeyName("kingdom-building-os"), "BLOTATO_API_KEY__KINGDOM_BUILDING_OS");
  assert.equal(ventureKeyName("lil-bull"), "BLOTATO_API_KEY__LIL_BULL");
});

test("a venture's own key wins; lil-bull alone falls back to the shared BLOTATO_API_KEY", () => {
  process.env.BLOTATO_API_KEY__COUPLESTHERAPY101 = CT101_KEY;
  assert.deepEqual(resolveBlotatoKey("couplestherapy101"), { key: CT101_KEY, source: "venture", placeholder: false });
  assert.deepEqual(resolveBlotatoKey("lil-bull"), { key: TEST_KEY, source: "shared", placeholder: false });
  process.env.BLOTATO_API_KEY__LIL_BULL = "blot-lil-bull-own-key==";
  assert.deepEqual(resolveBlotatoKey("lil-bull"), { key: "blot-lil-bull-own-key==", source: "venture", placeholder: false });
});

test("no key for a venture is NEVER another venture's key — it is dry-run, with the reason naming the env var", () => {
  // Shared key present, but kingdom-building-os has no key of its own.
  assert.deepEqual(resolveBlotatoKey("kingdom-building-os"), { key: null, source: "none", placeholder: false });
  assert.equal(isDryRun("kingdom-building-os"), true);
  assert.match(dryRunReason("kingdom-building-os"), /no BLOTATO_API_KEY__KINGDOM_BUILDING_OS/);
  assert.equal(isDryRun("lil-bull"), false, "the legacy venture keeps working on the shared key");
});

test("the placeholder value keeps a venture in dry run, per venture", () => {
  process.env.BLOTATO_API_KEY__COUPLESTHERAPY101 = "pending";
  assert.deepEqual(resolveBlotatoKey("couplestherapy101"), { key: null, source: "venture", placeholder: true });
  assert.equal(isDryRun("couplestherapy101"), true);
  assert.match(dryRunReason("couplestherapy101"), /BLOTATO_API_KEY__COUPLESTHERAPY101 is the "pending" placeholder/);
  process.env.BLOTATO_API_KEY = "pending";
  assert.equal(isDryRun("lil-bull"), true);
  assert.match(dryRunReason("lil-bull"), /BLOTATO_API_KEY is the "pending" placeholder/);
});

// --- publishing ---------------------------------------------------------------

test("publishPost: endpoint, method, THE VENTURE'S key verbatim in blotato-api-key, body, timeout signal", async () => {
  process.env.BLOTATO_API_KEY__COUPLESTHERAPY101 = CT101_KEY;
  const req = buildPublishRequest({
    platform: "instagram",
    accountId: "acc-ig",
    text: "hello",
    mediaUrls: ["https://database.blotato.io/m.png"],
  });
  const result = await publishPost("couplestherapy101", req);
  assert.deepEqual(result, { dryRun: false, postSubmissionId: "sub-123" });

  assert.ok(captured, "fetch was not called");
  assert.equal(captured.url, "https://backend.blotato.com/v2/posts");
  assert.equal(captured.init.method, "POST");
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers["blotato-api-key"], CT101_KEY, "the venture's own key, preserved verbatim, padding included");
  assert.notEqual(headers["blotato-api-key"], TEST_KEY, "never the shared key for a venture that has its own");
  assert.match(headers["content-type"] ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(String(captured.init.body)), req);
  assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
});

test("dry run: placeholder key sends nothing and returns the exact would-send request", async () => {
  process.env.BLOTATO_API_KEY = "pending";
  assert.equal(isDryRun("lil-bull"), true);
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  const result = await publishPost("lil-bull", req);
  assert.deepEqual(result, { dryRun: true, wouldSend: req });
  assert.equal(captured, null, "dry run must never touch the network");
});

test("dry run: BLOTATO_DRY_RUN=1 forces dry run even with a real key", async () => {
  process.env.BLOTATO_DRY_RUN = "1";
  assert.equal(isDryRun("lil-bull"), true);
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  const result = await publishPost("lil-bull", req);
  assert.equal(result.dryRun, true);
  assert.equal(captured, null);
});

test("publish rejection surfaces Blotato's message and status — never the key", async () => {
  nextResponse = () => new Response(JSON.stringify({ message: "Invalid account" }), { status: 422 });
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  await assert.rejects(publishPost("lil-bull", req), (err: Error) => {
    assert.match(err.message, /HTTP 422: Invalid account/);
    assert.ok(!err.message.includes(TEST_KEY), "the API key must never appear in error messages");
    return true;
  });
});

test("getPostStatus parses the documented shape, including terminal failure", async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ postSubmissionId: "sub-123", status: "failed", errorMessage: "media rejected" }), {
      status: 200,
    });
  const status = await getPostStatus("lil-bull", "sub-123");
  assert.equal(captured?.url, "https://backend.blotato.com/v2/posts/sub-123");
  assert.equal(captured?.init.method, "GET");
  assert.deepEqual(status, {
    postSubmissionId: "sub-123",
    status: "failed",
    publicUrl: undefined,
    errorMessage: "media rejected",
  });
});

// --- media --------------------------------------------------------------------

test("uploadMedia: POST /v2/media { url } with the venture's key → the Blotato-hosted url", async () => {
  process.env.BLOTATO_API_KEY__KINGDOM_BUILDING_OS = "blot-kbos-key==";
  nextResponse = () => new Response(JSON.stringify({ url: "https://database.blotato.io/abc/meme.png" }), { status: 201 });
  const result = await uploadMedia("kingdom-building-os", "https://proj.supabase.co/storage/v1/object/public/content-media/x/meme.png");
  assert.deepEqual(result, { dryRun: false, url: "https://database.blotato.io/abc/meme.png" });
  assert.equal(captured?.url, "https://backend.blotato.com/v2/media");
  assert.equal(captured?.init.method, "POST");
  assert.equal((captured?.init.headers as Record<string, string>)["blotato-api-key"], "blot-kbos-key==");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), {
    url: "https://proj.supabase.co/storage/v1/object/public/content-media/x/meme.png",
  });
});

test("uploadMedia: dry run returns the source url untouched and sends nothing; a non-http source is refused", async () => {
  const result = await uploadMedia("kingdom-building-os", "https://example.com/meme.png");
  assert.deepEqual(result, { dryRun: true, wouldSend: { url: "https://example.com/meme.png" } });
  assert.equal(captured, null);
  await assert.rejects(uploadMedia("lil-bull", "file:///tmp/meme.png"), /public http\(s\) URL/);
});

test("uploadMedia: a 201 without a hosted url, or a non-201, is an error naming Blotato's message", async () => {
  nextResponse = () => new Response(JSON.stringify({}), { status: 201 });
  await assert.rejects(uploadMedia("lil-bull", "https://example.com/meme.png"), /without a hosted url/);
  nextResponse = () => new Response(JSON.stringify({ message: "URL fetch failed" }), { status: 400 });
  await assert.rejects(uploadMedia("lil-bull", "https://example.com/meme.png"), /HTTP 400: URL fetch failed/);
});

// --- accounts -----------------------------------------------------------------

test("listAccounts parses items; with no real key it refuses with a clear message", async () => {
  nextResponse = () =>
    new Response(
      JSON.stringify({ items: [{ id: "acc-1", platform: "twitter", fullname: "Lil Bull", username: "lilbull" }] }),
      { status: 200 },
    );
  const accounts = await listAccounts("lil-bull");
  assert.equal(captured?.url, "https://backend.blotato.com/v2/users/me/accounts");
  assert.deepEqual(accounts, [{ id: "acc-1", platform: "twitter", fullname: "Lil Bull", username: "lilbull" }]);

  captured = null;
  await assert.rejects(listAccounts("couplestherapy101"), /real BLOTATO_API_KEY__COUPLESTHERAPY101 is required/);
  assert.equal(captured, null, "no request may be attempted without the venture's own key");
});

test("listSubaccounts hits the documented path and accepts both id spellings for the Page id", async () => {
  process.env.BLOTATO_API_KEY__COUPLESTHERAPY101 = CT101_KEY;
  nextResponse = () =>
    new Response(
      JSON.stringify({
        items: [
          { id: "page-1", accountId: "acc-fb", name: "CouplesTherapy101" },
          { pageId: "page-2", accountId: "acc-fb", name: "Second Page" },
          { accountId: "acc-fb" },
        ],
      }),
      { status: 200 },
    );
  const pages = await listSubaccounts("couplestherapy101", "acc-fb");
  assert.equal(captured?.url, "https://backend.blotato.com/v2/users/me/accounts/acc-fb/subaccounts");
  assert.deepEqual(pages, [
    { id: "page-1", name: "CouplesTherapy101" },
    { id: "page-2", name: "Second Page" },
  ]);
});
