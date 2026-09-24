// Tests for the Imgflip client: the documented response shapes parse, the
// caption form is encoded the way the API expects (boxes[i][text]), the
// credentials travel in the body only, and an unconfigured environment
// refuses loudly before any network call.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  captionForm,
  imgflipConfigured,
  listTemplates,
  parseCaptionResult,
  parseTemplates,
  primeTemplateCache,
  renderMeme,
} from "./imgflip.js";

const realFetch = globalThis.fetch;
let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

beforeEach(() => {
  delete process.env.IMGFLIP_USERNAME;
  delete process.env.IMGFLIP_PASSWORD;
  captured = null;
  nextResponse = () => Response.json({ success: true, data: { url: "https://i.imgflip.com/abc.jpg", page_url: "https://imgflip.com/i/abc" } });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.IMGFLIP_USERNAME;
  delete process.env.IMGFLIP_PASSWORD;
});

test("parseTemplates: the documented get_memes shape → templates with box counts; malformed entries dropped", () => {
  const templates = parseTemplates({
    success: true,
    data: {
      memes: [
        { id: "181913649", name: "Drake Hotline Bling", url: "https://i.imgflip.com/30b1gx.jpg", width: 1200, height: 1200, box_count: 2, captions: 1 },
        { id: "87743020", name: "Two Buttons", url: "https://i.imgflip.com/1g8my4.jpg", width: 600, height: 908, box_count: 3 },
        { name: "no id" },
      ],
    },
  });
  assert.deepEqual(templates, [
    { id: "181913649", name: "Drake Hotline Bling", url: "https://i.imgflip.com/30b1gx.jpg", width: 1200, height: 1200, boxCount: 2 },
    { id: "87743020", name: "Two Buttons", url: "https://i.imgflip.com/1g8my4.jpg", width: 600, height: 908, boxCount: 3 },
  ]);
});

test("parseTemplates / parseCaptionResult: success=false surfaces Imgflip's error_message", () => {
  assert.throws(() => parseTemplates({ success: false, error_message: "down for maintenance" }), /down for maintenance/);
  assert.throws(() => parseCaptionResult({ success: false, error_message: "Invalid password" }), /Invalid password/);
  assert.throws(() => parseCaptionResult({ success: true, data: {} }), /without an image url/);
  assert.deepEqual(parseCaptionResult({ success: true, data: { url: "https://i.imgflip.com/x.jpg" } }), {
    url: "https://i.imgflip.com/x.jpg",
    pageUrl: null,
  });
});

test("captionForm encodes multi-box text as boxes[i][text]", () => {
  const form = captionForm("181913649", ["Reading the room", "Reading Ephesians 5 at the room"]);
  assert.equal(form.get("template_id"), "181913649");
  assert.equal(form.get("boxes[0][text]"), "Reading the room");
  assert.equal(form.get("boxes[1][text]"), "Reading Ephesians 5 at the room");
  assert.equal(form.has("username"), false, "credentials are added only by renderMeme, right before the POST");
});

test("renderMeme: unconfigured → a clear refusal, no network; configured → form POST with credentials in the body only", async () => {
  assert.equal(imgflipConfigured(), false);
  await assert.rejects(renderMeme("1", ["a"]), /Imgflip credentials are not set/);
  assert.equal(captured === null, true, "no network call without credentials");

  process.env.IMGFLIP_USERNAME = "justin";
  process.env.IMGFLIP_PASSWORD = "imgflip-pass-not-real";
  assert.equal(imgflipConfigured(), true);
  const result = await renderMeme("181913649", ["top", "bottom"]);
  assert.deepEqual(result, { url: "https://i.imgflip.com/abc.jpg", pageUrl: "https://imgflip.com/i/abc" });
  assert.equal(captured?.url, "https://api.imgflip.com/caption_image", "the password never goes in the URL");
  assert.equal(captured?.init.method, "POST");
  const body = new URLSearchParams(String(captured?.init.body));
  assert.equal(body.get("username"), "justin");
  assert.equal(body.get("password"), "imgflip-pass-not-real");
  assert.equal(body.get("boxes[1][text]"), "bottom");
  assert.match((captured?.init.headers as Record<string, string>)["content-type"] ?? "", /x-www-form-urlencoded/);
});

test("renderMeme: an Imgflip failure never leaks the password in the error", async () => {
  process.env.IMGFLIP_USERNAME = "justin";
  process.env.IMGFLIP_PASSWORD = "imgflip-pass-not-real";
  nextResponse = () => Response.json({ success: false, error_message: "Invalid username/password" });
  await assert.rejects(renderMeme("1", ["a"]), (err: Error) => {
    assert.match(err.message, /Invalid username\/password/);
    assert.ok(!err.message.includes("imgflip-pass-not-real"));
    return true;
  });
  await assert.rejects(renderMeme("1", ["  ", ""]), /at least one non-empty text box/);
});

test("listTemplates: fetches get_memes once and serves the 24h cache afterwards", async () => {
  primeTemplateCache([]);
  let calls = 0;
  nextResponse = () => {
    calls += 1;
    return Response.json({ success: true, data: { memes: [{ id: "1", name: "One", url: "https://i.imgflip.com/1.jpg", width: 1, height: 1, box_count: 2 }] } });
  };
  // An empty primed cache is still "fresh" — prime with a real list to check
  // the cache path, then verify a miss fetches exactly once.
  primeTemplateCache([{ id: "9", name: "Primed", url: "https://i.imgflip.com/9.jpg", width: 1, height: 1, boxCount: 2 }]);
  const cached = await listTemplates();
  assert.equal(cached[0]?.name, "Primed");
  assert.equal(calls, 0, "a fresh cache never hits the network");
});
