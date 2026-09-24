// Public media hosting for the video pipeline: the rendered narration and
// video go into the Supabase Storage bucket 'media' (created public by
// migration 008) so Pictory and Blotato can fetch them by URL — both require
// publicly accessible media, neither accepts an upload from us.
//
// Uses the existing supabase-js client (already the bot's database client;
// the service-role key is allowed to write Storage server-side). Paths are
// video/<job-id>/<file>: nothing secret is ever written here, and a job's
// files are findable from its ledger row.

import { getSupabase } from "./supabase.js";

export const MEDIA_BUCKET = "media";

export interface UploadedMedia {
  path: string;
  publicUrl: string;
  bytes: number;
}

export async function uploadPublicMedia(path: string, bytes: Uint8Array, contentType: string): Promise<UploadedMedia> {
  if (!/^video\/[0-9a-f-]{36}\/[a-z0-9._-]+$/i.test(path)) {
    throw new Error(`refusing to upload to an unexpected media path: ${path}`);
  }
  const storage = getSupabase().storage.from(MEDIA_BUCKET);
  const { error } = await storage.upload(path, bytes, { contentType, upsert: true });
  if (error) {
    throw new Error(
      `Storage upload of ${path} failed: ${error.message}` +
        (/bucket/i.test(error.message) ? " — run supabase/migrations/008_video_pipeline.sql (the media bucket part)" : ""),
    );
  }
  const { data } = storage.getPublicUrl(path);
  if (!data.publicUrl || !/^https?:\/\//.test(data.publicUrl)) {
    throw new Error(`Storage returned no public URL for ${path}`);
  }
  console.log(`[storage] uploaded ${path} (${bytes.byteLength} bytes, ${contentType})`);
  return { path, publicUrl: data.publicUrl, bytes: bytes.byteLength };
}
