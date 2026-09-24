// Pictory video assembly — visuals + captions around OUR narration. Plain
// fetch, no SDK, same policy as every other HTTP integration here. Every
// request/response shape below was verified against docs.pictory.ai
// (api-reference/videos/create-storyboard-preview, render-from-preview,
// jobs/get-video-render-job-by-id); do not extend a shape without re-reading
// those docs.
//
// The external-audio question, answered from the docs: the storyboard
// request's voiceOver object accepts an `externalVoice` —
//   { "voiceUrl": "<public mp3 url>", "syncVoice": true, "amplificationLevel": 0 }
// — while the scene's `story` text still drives the scenes and captions. So
// the ElevenLabs narration (uploaded to Supabase Storage first, public URL)
// IS the voiceover track, synchronized to the script's captions.
//
// Flow (three calls, all async on Pictory's side, polled by the video step
// once per poller cycle):
//   POST /pictoryapis/v2/video/storyboard          → { data: { jobId } }   (preview)
//   GET  /pictoryapis/v1/jobs/{jobId}              → { data: { status, … } }
//   PUT  /pictoryapis/v2/video/render/{storyboardJobId} → { data: { jobId } } (final MP4)
//   GET  /pictoryapis/v1/jobs/{jobId}              → { data: { status, videoURL, videoDuration } }
// Job status is one of in-progress | completed | failed (failed carries
// error_message). Their docs ask for a 10–30s polling interval; the poller's
// 60s cycle satisfies that for free.
//
// Money: rendering spends Pictory video minutes (API self-serve plan). The
// caller runs only after the owner approved the script, once per script.
//
// Key hygiene: the key travels only in the Authorization header (Pictory's
// keys are the bare `pictai_…` string, no "Bearer"); errors carry the HTTP
// status and Pictory's own message, never headers.

const PICTORY_BASE_URL = "https://api.pictory.ai/pictoryapis";
const REQUEST_TIMEOUT_MS = 60_000;
// The rendered MP4 is fetched from Pictory's CDN to re-host it in our own
// Storage (their URLs are purged after a retention period).
const DOWNLOAD_TIMEOUT_MS = 180_000;

// 9:16 vertical: the one aspect ratio that is native to YouTube Shorts and
// Instagram Reels alike, which is where a 45–90 second narrated video lands.
export const VIDEO_ASPECT_RATIO = "9:16";
export const VIDEO_LANGUAGE = "en";

function requireKey(): string {
  const key = process.env.PICTORY_API_KEY;
  if (!key) throw new Error("PICTORY_API_KEY is not set");
  return key;
}

async function pictoryFetch(path: string, init: { method: "GET" | "POST" | "PUT"; body?: unknown }): Promise<Response> {
  const key = requireKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${PICTORY_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        authorization: key,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Pictory ${path}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Pictory ${path}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Surface Pictory's own error message — never our request headers.
async function errorDetail(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown; error_message?: unknown };
    const message = [body.message, body.error_message, body.error].find((m) => typeof m === "string") as string | undefined;
    if (message) detail = `HTTP ${res.status}: ${message}`;
  } catch {
    // Non-JSON error body — the status alone will have to do.
  }
  return detail;
}

function jobIdOf(body: unknown, what: string): string {
  const data = (body as { data?: { jobId?: unknown } } | null)?.data;
  if (typeof data?.jobId !== "string" || !data.jobId) throw new Error(`Pictory ${what} answered without a jobId`);
  return data.jobId;
}

export interface StoryboardArgs {
  videoName: string; // alphanumeric, spaces, _ and - only, max 150 chars (enforced below)
  script: string; // the approved spoken script — drives scenes and captions
  narrationUrl: string; // PUBLIC mp3 url of the ElevenLabs narration
}

// The exact storyboard-preview request. Exported for the request test.
export function buildStoryboardRequest(args: StoryboardArgs): Record<string, unknown> {
  if (!/^https?:\/\//.test(args.narrationUrl)) {
    throw new Error("Pictory: the narration must be a public http(s) URL");
  }
  const videoName = args.videoName.replace(/[^A-Za-z0-9 _-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "godley-os-video";
  return {
    videoName,
    language: VIDEO_LANGUAGE,
    aspectRatio: VIDEO_ASPECT_RATIO,
    voiceOver: {
      enabled: true,
      externalVoice: { voiceUrl: args.narrationUrl, syncVoice: true, amplificationLevel: 0 },
    },
    backgroundMusic: { enabled: false },
    scenes: [
      {
        story: args.script,
        createSceneOnEndOfSentence: true,
        highlightKeywords: true,
      },
    ],
  };
}

export async function createStoryboard(args: StoryboardArgs): Promise<string> {
  const request = buildStoryboardRequest(args);
  const res = await pictoryFetch("/v2/video/storyboard", { method: "POST", body: request });
  if (!res.ok) throw new Error(`Pictory storyboard rejected: ${await errorDetail(res)}`);
  const jobId = jobIdOf(await res.json(), "storyboard");
  console.log(`[pictory] storyboard submitted (job ${jobId})`);
  return jobId;
}

export async function renderFromPreview(storyboardJobId: string): Promise<string> {
  const res = await pictoryFetch(`/v2/video/render/${encodeURIComponent(storyboardJobId)}`, { method: "PUT", body: {} });
  if (!res.ok) throw new Error(`Pictory render rejected: ${await errorDetail(res)}`);
  const jobId = jobIdOf(await res.json(), "render");
  console.log(`[pictory] render submitted (job ${jobId} from storyboard ${storyboardJobId})`);
  return jobId;
}

export type PictoryJob =
  | { status: "in-progress"; progress: number | null }
  | { status: "completed"; videoUrl: string | null; videoSeconds: number | null }
  | { status: "failed"; error: string };

export async function getJob(jobId: string): Promise<PictoryJob> {
  const res = await pictoryFetch(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: "GET" });
  if (!res.ok) throw new Error(`Pictory job status failed: ${await errorDetail(res)}`);
  const body = (await res.json()) as { data?: Record<string, unknown> };
  const data = body.data ?? {};
  const status = data.status;
  if (status === "completed") {
    return {
      status,
      videoUrl: typeof data.videoURL === "string" ? data.videoURL : null,
      videoSeconds: typeof data.videoDuration === "number" ? data.videoDuration : null,
    };
  }
  if (status === "failed") {
    const message = [data.error_message, data.errorMessage, data.error].find((m) => typeof m === "string") as
      | string
      | undefined;
    return { status, error: message ?? "Pictory reported failure without a message" };
  }
  if (status === "in-progress") {
    return { status, progress: typeof data.renderProgress === "number" ? data.renderProgress : null };
  }
  throw new Error(`Pictory job status returned unknown status ${JSON.stringify(status)}`);
}

export interface DownloadedVideo {
  bytes: Uint8Array;
  contentType: string;
}

// The finished MP4, fetched from Pictory's CDN so it can be re-hosted in our
// Storage. Not an API call (no key is sent — the URL is public).
export async function downloadRendered(videoUrl: string): Promise<DownloadedVideo> {
  if (!/^https:\/\//.test(videoUrl)) throw new Error("Pictory returned a non-https video URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(videoUrl, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`downloading the rendered video timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
    throw new Error(`downloading the rendered video failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`downloading the rendered video failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("the rendered video download was empty");
  const contentType = (res.headers.get("content-type") ?? "video/mp4").split(";")[0]!.trim();
  return { bytes, contentType: contentType.startsWith("video/") ? contentType : "video/mp4" };
}
