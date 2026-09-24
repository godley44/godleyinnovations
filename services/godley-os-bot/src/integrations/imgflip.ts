// Imgflip meme rendering — plain fetch, no SDK, same policy as every other
// HTTP integration here. Shapes verified against https://imgflip.com/api:
//
//   GET  https://api.imgflip.com/get_memes
//        → { success: true, data: { memes: [{ id, name, url, width, height, box_count }] } }
//        Free, no credentials. The top ~100 templates; cached in memory ~24h.
//   POST https://api.imgflip.com/caption_image   (form-encoded)
//        template_id, username, password, boxes[i][text] (multi-box; text0 /
//        text1 are the two-box shorthand), optional font / max_font_size
//        → { success: true, data: { url, page_url } }
//        → { success: false, error_message }
//        Free tier renders carry a small imgflip.com watermark in a corner;
//        Imgflip Premium (~$10/month) removes it (no_watermark) — the owner's
//        call later, nothing here depends on it.
//
// Rendering is NOT publishing: the render is a preview image the owner looks
// at in the Slack thread. What publishes is a copy mirrored into Storage at
// filing time, and only after the approval gate. Credentials
// (IMGFLIP_USERNAME / IMGFLIP_PASSWORD) travel only in the POST body, never
// in a URL, log, or error message; with them unset the content agent offers
// reposts only and says riffs need Imgflip credentials.

const GET_MEMES_URL = "https://api.imgflip.com/get_memes";
const CAPTION_IMAGE_URL = "https://api.imgflip.com/caption_image";
const REQUEST_TIMEOUT_MS = 30_000;
const TEMPLATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface MemeTemplate {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  boxCount: number;
}

export function imgflipConfigured(): boolean {
  return Boolean(process.env.IMGFLIP_USERNAME?.trim() && process.env.IMGFLIP_PASSWORD);
}

// Pure parsers — exported so the response shapes are unit-tested without
// the network.
export function parseTemplates(body: unknown): MemeTemplate[] {
  if (typeof body !== "object" || body === null) throw new Error("Imgflip get_memes: response is not an object");
  const b = body as { success?: unknown; error_message?: unknown; data?: { memes?: unknown } };
  if (b.success !== true) {
    throw new Error(`Imgflip get_memes failed: ${typeof b.error_message === "string" ? b.error_message : "success=false"}`);
  }
  const memes = Array.isArray(b.data?.memes) ? b.data.memes : [];
  return memes.flatMap((raw): MemeTemplate[] => {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.name !== "string" || typeof m.url !== "string") return [];
    return [
      {
        id: m.id,
        name: m.name,
        url: m.url,
        width: typeof m.width === "number" ? m.width : 0,
        height: typeof m.height === "number" ? m.height : 0,
        boxCount: typeof m.box_count === "number" ? m.box_count : 2,
      },
    ];
  });
}

export function parseCaptionResult(body: unknown): { url: string; pageUrl: string | null } {
  if (typeof body !== "object" || body === null) throw new Error("Imgflip caption_image: response is not an object");
  const b = body as { success?: unknown; error_message?: unknown; data?: { url?: unknown; page_url?: unknown } };
  if (b.success !== true) {
    throw new Error(`Imgflip caption_image failed: ${typeof b.error_message === "string" ? b.error_message : "success=false"}`);
  }
  const url = b.data?.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    throw new Error("Imgflip caption_image returned success without an image url");
  }
  return { url, pageUrl: typeof b.data?.page_url === "string" ? b.data.page_url : null };
}

// The exact form body caption_image takes: boxes[i][text] per text box.
// Pure and exported so the encoding is pinned by a test; the credentials
// are added by the caller right before the POST.
export function captionForm(templateId: string, texts: string[]): URLSearchParams {
  const form = new URLSearchParams();
  form.set("template_id", templateId);
  texts.forEach((text, i) => form.set(`boxes[${i}][text]`, text));
  return form;
}

async function timedFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Imgflip ${label}: timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw new Error(`Imgflip ${label}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

let templateCache: { at: number; templates: MemeTemplate[] } | null = null;

export async function listTemplates(): Promise<MemeTemplate[]> {
  if (templateCache && Date.now() - templateCache.at < TEMPLATE_CACHE_TTL_MS) return templateCache.templates;
  const res = await timedFetch(GET_MEMES_URL, { method: "GET" }, "get_memes");
  if (!res.ok) throw new Error(`Imgflip get_memes: HTTP ${res.status}`);
  const templates = parseTemplates(await res.json());
  if (templates.length === 0) throw new Error("Imgflip get_memes returned no templates");
  templateCache = { at: Date.now(), templates };
  return templates;
}

// Test seam: lets a suite prime the cache without the network.
export function primeTemplateCache(templates: MemeTemplate[]): void {
  templateCache = { at: Date.now(), templates };
}

export interface RenderResult {
  url: string; // i.imgflip.com image
  pageUrl: string | null;
}

export async function renderMeme(templateId: string, texts: string[]): Promise<RenderResult> {
  const username = process.env.IMGFLIP_USERNAME?.trim();
  const password = process.env.IMGFLIP_PASSWORD;
  if (!username || !password) {
    throw new Error("Imgflip credentials are not set (IMGFLIP_USERNAME / IMGFLIP_PASSWORD) — riffs are unavailable, reposts still work");
  }
  if (!templateId.trim()) throw new Error("Imgflip caption_image: template_id is required");
  const cleaned = texts.map((t) => t.trim());
  if (cleaned.length === 0 || cleaned.every((t) => t === "")) {
    throw new Error("Imgflip caption_image: at least one non-empty text box is required");
  }
  const form = captionForm(templateId.trim(), cleaned);
  // Credentials go in the body only (the docs forbid the password in a URL).
  form.set("username", username);
  form.set("password", password);
  const res = await timedFetch(
    CAPTION_IMAGE_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: form.toString(),
    },
    "caption_image",
  );
  if (!res.ok) throw new Error(`Imgflip caption_image: HTTP ${res.status}`);
  return parseCaptionResult(await res.json());
}

// Fetch a render's bytes so the filing step can mirror it into Storage
// (publishing never depends on Imgflip's hosting). Restricted to Imgflip's
// image host — the url comes from the model's tool input, so it is checked
// here rather than trusted.
export const IMGFLIP_IMAGE_HOST_RE = /^https:\/\/i\.imgflip\.com\/[A-Za-z0-9._-]+$/;

export async function downloadRender(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!IMGFLIP_IMAGE_HOST_RE.test(url)) throw new Error(`refusing to fetch a render from outside i.imgflip.com: ${url}`);
  const res = await timedFetch(url, { method: "GET" }, "render download");
  if (!res.ok) throw new Error(`Imgflip render download: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  if (!/^image\//i.test(contentType)) throw new Error(`Imgflip render download: not an image (${contentType})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
}
