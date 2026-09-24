// ElevenLabs text-to-speech — the owner's cloned voice reads the approved
// video script. Plain fetch, no SDK, same policy as every other HTTP
// integration here. Every request/response shape below was verified against
// elevenlabs.io/docs (api-reference/text-to-speech/convert, voices/search);
// do not extend a shape without re-reading those docs.
//
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=…
//        header xi-api-key, body { text, model_id, voice_settings? }
//        → raw audio bytes (audio/mpeg for the mp3 formats)
//   GET  https://api.elevenlabs.io/v2/voices?category=cloned&page_size=100
//        → { voices: [{ voice_id, name, category, … }], has_more, … }
//
// Money: every call spends characters from the ElevenLabs plan (cloned
// voices need the Creator tier or higher). The caller (the video_jobs step)
// runs only after the owner approved the script, and only once per script.
//
// Key hygiene: the key travels only in the xi-api-key header; errors carry
// the HTTP status and ElevenLabs' own message, never headers.

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const REQUEST_TIMEOUT_MS = 120_000;

// The single place to change the voice model. eleven_multilingual_v2 is the
// most lifelike, 10,000-character cap per request (our scripts are ~1,500),
// and works with cloned voices. eleven_flash_v2_5 is the cheaper/faster
// alternative if cost ever matters more than delivery.
export const TTS_MODEL = "eleven_multilingual_v2";
// mp3 44.1kHz 128kbps — the API default, and what both Pictory and Blotato
// accept as an audio track.
export const TTS_OUTPUT_FORMAT = "mp3_44100_128";
export const TTS_CONTENT_TYPE = "audio/mpeg";
// Hard stop well under the model's cap: a runaway script can't get expensive.
export const TTS_MAX_CHARS = 4_000;

function requireKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  return key;
}

async function elevenFetch(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Response> {
  const key = requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${ELEVENLABS_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        "xi-api-key": key,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`ElevenLabs ${path}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`ElevenLabs ${path}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Surface ElevenLabs' own error message — never our request headers. Their
// error body is { detail: { status, message } } or { detail: "…" }.
async function errorDetail(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: unknown };
    const d = body.detail;
    const message =
      typeof d === "string"
        ? d
        : typeof d === "object" && d !== null && typeof (d as { message?: unknown }).message === "string"
          ? ((d as { message: string }).message)
          : null;
    if (message) detail = `HTTP ${res.status}: ${message}`;
  } catch {
    // Non-JSON error body — the status alone will have to do.
  }
  return detail;
}

export interface SynthesizeArgs {
  voiceId: string;
  text: string;
}

export interface SynthesizedAudio {
  bytes: Uint8Array;
  contentType: string;
}

export async function synthesizeSpeech(args: SynthesizeArgs): Promise<SynthesizedAudio> {
  if (!args.voiceId.trim()) throw new Error("ElevenLabs: a voice id is required");
  const text = args.text.trim();
  if (!text) throw new Error("ElevenLabs: the script is empty — nothing to narrate");
  if (text.length > TTS_MAX_CHARS) {
    throw new Error(`ElevenLabs: the script is ${text.length} characters, over the ${TTS_MAX_CHARS} cap — shorten it`);
  }
  const path = `/v1/text-to-speech/${encodeURIComponent(args.voiceId)}?output_format=${TTS_OUTPUT_FORMAT}`;
  const res = await elevenFetch(path, { method: "POST", body: { text, model_id: TTS_MODEL } });
  if (!res.ok) throw new Error(`ElevenLabs text-to-speech failed: ${await errorDetail(res)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("ElevenLabs text-to-speech returned no audio");
  const contentType = res.headers.get("content-type") ?? TTS_CONTENT_TYPE;
  console.log(`[elevenlabs] ${TTS_MODEL} chars=${text.length} bytes=${bytes.byteLength}`);
  return { bytes, contentType: contentType.split(";")[0]!.trim() || TTS_CONTENT_TYPE };
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category: string;
}

// The account's cloned voices — used once per venture to resolve
// ventures.elevenlabs_voice_id when it is NULL (exactly one clone in the
// account = the owner's; anything else is an explicit configuration step).
export async function listClonedVoices(): Promise<ElevenLabsVoice[]> {
  const res = await elevenFetch("/v2/voices?category=cloned&page_size=100", { method: "GET" });
  if (!res.ok) throw new Error(`ElevenLabs voices listing failed: ${await errorDetail(res)}`);
  const body = (await res.json()) as { voices?: unknown };
  const voices = Array.isArray(body.voices) ? body.voices : [];
  return voices.flatMap((raw) => {
    const v = raw as Record<string, unknown>;
    return typeof v.voice_id === "string" && typeof v.name === "string"
      ? [{ voiceId: v.voice_id, name: v.name, category: typeof v.category === "string" ? v.category : "" }]
      : [];
  });
}
