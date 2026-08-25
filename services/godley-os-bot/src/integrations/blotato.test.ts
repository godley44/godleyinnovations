// Tests for the Blotato client: per-platform request builders against the
// DOCUMENTED schema (help.blotato.com/api/publish-post), request
// construction against a mocked fetch (CI never hits the API), the dry-run
// path, and key hygiene. Each test file runs in its own process under
// `node --test`, so env/fetch swaps cannot leak between suites.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  buildPublishRequest,
  getPostStatus,
  isDryRun,
  listAccounts,
  publishPost,
} from "./blotato.js";

// Trailing "=" on purpose: Blotato keys carry base64 padding that must
// survive verbatim into the header.
const TEST_KEY = "blot-test-key-not-real==";

const realFetch = globalThis.fetch;
let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

beforeEach(() => {
  process.env.BLOTATO_API_KEY = TEST_KEY;
  delete process.env.BLOTATO_DRY_RUN;
  captured = null;
  nextResponse = () => new Response(JSON.stringify({ postSubmissionId: "sub-123" }), { status: 201 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BLOTATO_API_KEY;
  delete process.env.BLOTATO_DRY_RUN;
});

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

test("publishPost: endpoint, method, blotato-api-key header verbatim, body, timeout signal", async () => {
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  const result = await publishPost(req);
  assert.deepEqual(result, { dryRun: false, postSubmissionId: "sub-123" });

  assert.ok(captured, "fetch was not called");
  assert.equal(captured.url, "https://backend.blotato.com/v2/posts");
  assert.equal(captured.init.method, "POST");
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers["blotato-api-key"], TEST_KEY, "key must be preserved verbatim, padding included");
  assert.match(headers["content-type"] ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(String(captured.init.body)), req);
  assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
});

test("dry run: placeholder key sends nothing and returns the exact would-send request", async () => {
  process.env.BLOTATO_API_KEY = "pending";
  assert.equal(isDryRun(), true);
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  const result = await publishPost(req);
  assert.deepEqual(result, { dryRun: true, wouldSend: req });
  assert.equal(captured, null, "dry run must never touch the network");
});

test("dry run: BLOTATO_DRY_RUN=1 forces dry run even with a real key", async () => {
  process.env.BLOTATO_DRY_RUN = "1";
  assert.equal(isDryRun(), true);
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  const result = await publishPost(req);
  assert.equal(result.dryRun, true);
  assert.equal(captured, null);
});

test("publish rejection surfaces Blotato's message and status — never the key", async () => {
  nextResponse = () => new Response(JSON.stringify({ message: "Invalid account" }), { status: 422 });
  const req = buildPublishRequest({ platform: "twitter", accountId: "acc-tw", text: "hello", mediaUrls: [] });
  await assert.rejects(publishPost(req), (err: Error) => {
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
  const status = await getPostStatus("sub-123");
  assert.equal(captured?.url, "https://backend.blotato.com/v2/posts/sub-123");
  assert.equal(captured?.init.method, "GET");
  assert.deepEqual(status, {
    postSubmissionId: "sub-123",
    status: "failed",
    publicUrl: undefined,
    errorMessage: "media rejected",
  });
});

test("listAccounts parses items; with the placeholder key it refuses with a clear message", async () => {
  nextResponse = () =>
    new Response(
      JSON.stringify({ items: [{ id: "acc-1", platform: "twitter", fullname: "Lil Bull", username: "lilbull" }] }),
      { status: 200 },
    );
  const accounts = await listAccounts();
  assert.equal(captured?.url, "https://backend.blotato.com/v2/users/me/accounts");
  assert.deepEqual(accounts, [{ id: "acc-1", platform: "twitter", fullname: "Lil Bull", username: "lilbull" }]);

  process.env.BLOTATO_API_KEY = "pending";
  captured = null;
  await assert.rejects(listAccounts(), /real BLOTATO_API_KEY is required/);
  assert.equal(captured, null, "no request may be attempted with the placeholder key");
});
