// The public media mirror: Supabase Storage bucket `content-media`, written
// with the service-role key through the SAME supabase-js client the rest of
// the bot uses for the database (no new SDK, no new raw-HTTP file). Every
// image the content pipeline publishes lives here first — a Slack file is
// private and expires with the workspace token, an Imgflip render is on a
// third party's hosting — so a publish never depends on either.
//
// Layout: <venture_slug>/<content_item_id>/<file>. Public READ is the point
// (Blotato and the vision model fetch by URL); writes are service-role only.
// The bucket is created by migration 008 and, belt and braces, on first use
// here if it is somehow missing.

import { getSupabase } from "./supabase.js";

export const CONTENT_MEDIA_BUCKET = "content-media";

// Slack image mimetypes the pipeline accepts; anything else is refused at
// the door (Instagram publishes images and video only — video is a later
// phase).
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

export function extensionFor(contentType: string): string | null {
  return IMAGE_EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function isImageContentType(contentType: string): boolean {
  return extensionFor(contentType) !== null;
}

export interface MirrorArgs {
  ventureSlug: string;
  contentItemId: string;
  fileName: string; // e.g. "source.png" or "riff.jpg"
  contentType: string;
  bytes: Uint8Array;
}

export interface MirrorResult {
  path: string;
  publicUrl: string;
}

let bucketEnsured = false;

async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const storage = getSupabase().storage;
  const { data, error } = await storage.getBucket(CONTENT_MEDIA_BUCKET);
  if (!error && data) {
    bucketEnsured = true;
    return;
  }
  const { error: createError } = await storage.createBucket(CONTENT_MEDIA_BUCKET, { public: true });
  // A concurrent creator (or the migration) winning the race is fine.
  if (createError && !/already exists|duplicate/i.test(createError.message)) {
    throw new Error(`could not create the ${CONTENT_MEDIA_BUCKET} bucket: ${createError.message}`);
  }
  bucketEnsured = true;
}

// Uploads the bytes and returns the public URL. Upsert on purpose: the path
// is unique per (item, file name), so a retry after a half-failed run
// overwrites its own earlier copy and nothing else.
export async function mirrorToStorage(args: MirrorArgs): Promise<MirrorResult> {
  const safeName = args.fileName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "file";
  const path = `${args.ventureSlug}/${args.contentItemId}/${safeName}`;
  await ensureBucket();
  const storage = getSupabase().storage.from(CONTENT_MEDIA_BUCKET);
  const { error } = await storage.upload(path, args.bytes, { contentType: args.contentType, upsert: true });
  if (error) throw new Error(`Storage upload of ${path} failed: ${error.message}`);
  const { data } = storage.getPublicUrl(path);
  if (!data.publicUrl) throw new Error(`Storage returned no public URL for ${path}`);
  return { path, publicUrl: data.publicUrl };
}
