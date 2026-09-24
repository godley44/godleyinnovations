// Request construction and job-status handling for the Pictory client
// against a mocked fetch — CI never hits Pictory. Own process under
// `node --test`, so the fetch/env swap cannot leak.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  buildStoryboardRequest,
  createStoryboard,
  downloadRendered,
  getJob,
  renderFromPreview,
  VIDEO_ASPECT_RATIO,
} from "./pictory.js";

const realFetch = globalThis.fetch;
const TEST_KEY = "pictai_test_key_not_real";

let captured: { url: string; init: RequestInit }[] = [];
let nextResponse: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  process.env.PICTORY_API_KEY = TEST_KEY;
  captured = [];
  nextResponse = () => json({ success: true, data: { jobId: "job-1" } });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PICTORY_API_KEY;
});

test("storyboard request: the ElevenLabs narration rides as voiceOver.externalVoice, the script drives scenes, 9:16", () => {
  const req = buildStoryboardRequest({
    videoName: 'Lil Bull: week of "Sept 29"!',
    script: "One takeaway. Then the rest.",
    narrationUrl: "https://x.supabase.co/storage/v1/object/public/media/video/j/narration.mp3",
  });
  assert.equal(req.videoName, "Lil Bull week of Sept 29", "Pictory allows alphanumerics, spaces, _ and - only");
  assert.equal(req.aspectRatio, VIDEO_ASPECT_RATIO);
  assert.equal(req.aspectRatio, "9:16");
  assert.deepEqual(req.voiceOver, {
    enabled: true,
    externalVoice: {
      voiceUrl: "https://x.supabase.co/storage/v1/object/public/media/video/j/narration.mp3",
      syncVoice: true,
      amplificationLevel: 0,
    },
  });
  assert.deepEqual(req.backgroundMusic, { enabled: false });
  const scenes = req.scenes as { story: string }[];
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0]!.story, "One takeaway. Then the rest.");
  assert.equal("aiVoices" in (req.voiceOver as object), false, "no AI voice — the cloned voice is the narration");
});

test("a non-public narration URL is refused before any network call", () => {
  assert.throws(() => buildStoryboardRequest({ videoName: "v", script: "s", narrationUrl: "file:///tmp/a.mp3" }), /public http/);
  assert.equal(captured.length, 0);
});

test("createStoryboard: POST /v2/video/storyboard with the bare key in Authorization; jobId returned", async () => {
  const jobId = await createStoryboard({ videoName: "v", script: "s", narrationUrl: "https://a/b.mp3" });
  assert.equal(jobId, "job-1");
  assert.equal(captured[0]!.url, "https://api.pictory.ai/pictoryapis/v2/video/storyboard");
  assert.equal(captured[0]!.init.method, "POST");
  const headers = captured[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, TEST_KEY, "Pictory keys are sent bare, no Bearer prefix");
});

test("renderFromPreview: PUT /v2/video/render/{storyboardJobId}", async () => {
  nextResponse = () => json({ success: true, data: { jobId: "render-9" } });
  const jobId = await renderFromPreview("sb-1");
  assert.equal(jobId, "render-9");
  assert.equal(captured[0]!.url, "https://api.pictory.ai/pictoryapis/v2/video/render/sb-1");
  assert.equal(captured[0]!.init.method, "PUT");
});

test("getJob: in-progress, completed (videoURL + duration), failed (error_message), unknown", async () => {
  nextResponse = () => json({ data: { status: "in-progress", renderProgress: 42 } });
  assert.deepEqual(await getJob("j"), { status: "in-progress", progress: 42 });
  assert.equal(captured[0]!.url, "https://api.pictory.ai/pictoryapis/v1/jobs/j");

  nextResponse = () => json({ data: { status: "completed", videoURL: "https://cdn/v.mp4", videoDuration: 61.2 } });
  assert.deepEqual(await getJob("j"), { status: "completed", videoUrl: "https://cdn/v.mp4", videoSeconds: 61.2 });

  nextResponse = () => json({ data: { status: "failed", error_code: "E1", error_message: "no visuals found" } });
  assert.deepEqual(await getJob("j"), { status: "failed", error: "no visuals found" });

  nextResponse = () => json({ data: { status: "weird" } });
  await assert.rejects(getJob("j"), /unknown status/);
});

test("API error surfaces Pictory's message and status — never the key", async () => {
  nextResponse = () => json({ message: "Quota exceeded" }, 402);
  await assert.rejects(createStoryboard({ videoName: "v", script: "s", narrationUrl: "https://a/b.mp3" }), (err: Error) => {
    assert.match(err.message, /HTTP 402: Quota exceeded/);
    assert.ok(!err.message.includes(TEST_KEY));
    return true;
  });
});

test("downloadRendered: fetches the public MP4 without any key, refuses non-https and empty bodies", async () => {
  nextResponse = () => new Response(new Uint8Array([9, 9]), { status: 200, headers: { "content-type": "video/mp4" } });
  const video = await downloadRendered("https://cdn/v.mp4");
  assert.deepEqual([...video.bytes], [9, 9]);
  assert.equal(video.contentType, "video/mp4");
  const headers = (captured[0]!.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, undefined, "the CDN download carries no API key");

  await assert.rejects(downloadRendered("http://cdn/v.mp4"), /non-https/);
  nextResponse = () => new Response(new Uint8Array([]), { status: 200 });
  await assert.rejects(downloadRendered("https://cdn/v.mp4"), /empty/);
});

test("missing key fails before any network call", async () => {
  delete process.env.PICTORY_API_KEY;
  await assert.rejects(createStoryboard({ videoName: "v", script: "s", narrationUrl: "https://a/b.mp3" }), /PICTORY_API_KEY is not set/);
  assert.equal(captured.length, 0);
});
