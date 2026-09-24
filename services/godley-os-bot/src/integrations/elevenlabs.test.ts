// Request construction and response handling for the ElevenLabs client
// against a mocked fetch — CI never hits ElevenLabs. Own process under
// `node --test`, so the fetch/env swap cannot leak.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { listClonedVoices, synthesizeSpeech, TTS_MAX_CHARS, TTS_MODEL, TTS_OUTPUT_FORMAT } from "./elevenlabs.js";

const realFetch = globalThis.fetch;
const TEST_KEY = "xi-test-key-not-real-123";

let captured: { url: string; init: RequestInit } | null = null;
let nextResponse: () => Response;

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = TEST_KEY;
  captured = null;
  nextResponse = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return nextResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ELEVENLABS_API_KEY;
});

test("text-to-speech: endpoint with voice id and output format, xi-api-key header, model constant, audio bytes back", async () => {
  const audio = await synthesizeSpeech({ voiceId: "voice_abc", text: "  Hello there.  " });
  assert.deepEqual([...audio.bytes], [1, 2, 3, 4]);
  assert.equal(audio.contentType, "audio/mpeg");

  assert.ok(captured, "fetch was not called");
  assert.equal(captured.url, `https://api.elevenlabs.io/v1/text-to-speech/voice_abc?output_format=${TTS_OUTPUT_FORMAT}`);
  assert.equal(captured.init.method, "POST");
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers["xi-api-key"], TEST_KEY);
  assert.equal(headers.authorization, undefined, "no bearer header — ElevenLabs uses xi-api-key");
  const body = JSON.parse(String(captured.init.body)) as { text: string; model_id: string };
  assert.equal(body.text, "Hello there.", "text is trimmed");
  assert.equal(body.model_id, TTS_MODEL);
  assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal must be attached");
});

test("refuses an empty script, an over-cap script, and a blank voice id before any network call", async () => {
  await assert.rejects(synthesizeSpeech({ voiceId: "v", text: "   " }), /script is empty/);
  await assert.rejects(synthesizeSpeech({ voiceId: "v", text: "x".repeat(TTS_MAX_CHARS + 1) }), /over the .* cap/);
  await assert.rejects(synthesizeSpeech({ voiceId: " ", text: "hello" }), /voice id is required/);
  assert.equal(captured, null);
});

test("API error surfaces ElevenLabs' detail message and status — never the key", async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "You have exceeded your quota" } }), { status: 401 });
  await assert.rejects(synthesizeSpeech({ voiceId: "v", text: "hello" }), (err: Error) => {
    assert.match(err.message, /HTTP 401: You have exceeded your quota/);
    assert.ok(!err.message.includes(TEST_KEY));
    return true;
  });
});

test("empty audio body is an error, not a silent empty file", async () => {
  nextResponse = () => new Response(new Uint8Array([]), { status: 200 });
  await assert.rejects(synthesizeSpeech({ voiceId: "v", text: "hello" }), /returned no audio/);
});

test("cloned voices: GET /v2/voices filtered to cloned, normalized rows", async () => {
  nextResponse = () =>
    new Response(
      JSON.stringify({
        voices: [
          { voice_id: "c1", name: "Justin", category: "cloned" },
          { voice_id: 5, name: "bad" },
        ],
        has_more: false,
      }),
      { status: 200 },
    );
  const voices = await listClonedVoices();
  assert.deepEqual(voices, [{ voiceId: "c1", name: "Justin", category: "cloned" }]);
  assert.equal(captured!.url, "https://api.elevenlabs.io/v2/voices?category=cloned&page_size=100");
  assert.equal(captured!.init.method, "GET");
});

test("missing key fails before any network call", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(synthesizeSpeech({ voiceId: "v", text: "hello" }), /ELEVENLABS_API_KEY is not set/);
  assert.equal(captured, null);
});
