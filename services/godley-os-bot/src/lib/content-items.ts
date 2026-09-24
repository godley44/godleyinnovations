// content_items (migration 009) — one row per image the owner dropped in a
// high-touch venture channel. The data access for the content agent lives
// here so the agent's logic stays pure and testable with fakes.
//
// Status lifecycle (written only by the bot, service role):
//   'queued'    one of several images in a drop, not picked yet
//   'open'      the image the thread is currently working on (at most one per thread)
//   'proposed'  file_for_approval ran: a calendar row + social.post proposal exist
//   'published' | 'partial' | 'failed' | 'rejected'   mirrored from the post's outcome

import { getSupabase } from "./supabase.js";

export type ContentItemStatus = "queued" | "open" | "proposed" | "published" | "partial" | "failed" | "rejected";

export interface ContentItem {
  id: string;
  ventureId: string;
  contentType: string;
  status: ContentItemStatus;
  threadIndex: number;
  fileName: string | null;
  slackFileId: string | null;
  slackChannelId: string;
  slackThreadTs: string;
  sourceImageUrl: string | null;
  mediaUrl: string | null;
  renderUrl: string | null;
  sourceKind: "repost" | "riff" | "original" | null;
  sourceCredit: string | null;
  imgflipTemplateId: string | null;
  captions: Record<string, string>;
}

const ITEM_COLS =
  "id, venture_id, content_type, status, thread_index, file_name, slack_file_id, slack_channel_id, slack_thread_ts, " +
  "source_image_url, media_url, render_url, source_kind, source_credit, imgflip_template_id, captions";

const STATUSES: readonly string[] = ["queued", "open", "proposed", "published", "partial", "failed", "rejected"];

export function normalizeItem(raw: unknown): ContentItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.venture_id !== "string") return null;
  if (typeof d.slack_channel_id !== "string" || typeof d.slack_thread_ts !== "string") return null;
  const status = typeof d.status === "string" && STATUSES.includes(d.status) ? (d.status as ContentItemStatus) : "open";
  const kind = d.source_kind === "repost" || d.source_kind === "riff" || d.source_kind === "original" ? d.source_kind : null;
  const captions: Record<string, string> = {};
  if (typeof d.captions === "object" && d.captions !== null && !Array.isArray(d.captions)) {
    for (const [k, v] of Object.entries(d.captions as Record<string, unknown>)) {
      if (typeof v === "string") captions[k] = v;
    }
  }
  return {
    id: d.id,
    ventureId: d.venture_id,
    contentType: typeof d.content_type === "string" ? d.content_type : "meme",
    status,
    threadIndex: typeof d.thread_index === "number" ? d.thread_index : 1,
    fileName: typeof d.file_name === "string" ? d.file_name : null,
    slackFileId: typeof d.slack_file_id === "string" ? d.slack_file_id : null,
    slackChannelId: d.slack_channel_id,
    slackThreadTs: d.slack_thread_ts,
    sourceImageUrl: typeof d.source_image_url === "string" ? d.source_image_url : null,
    mediaUrl: typeof d.media_url === "string" ? d.media_url : null,
    renderUrl: typeof d.render_url === "string" ? d.render_url : null,
    sourceKind: kind,
    sourceCredit: typeof d.source_credit === "string" ? d.source_credit : null,
    imgflipTemplateId: typeof d.imgflip_template_id === "string" ? d.imgflip_template_id : null,
    captions,
  };
}

const MIGRATION_HINT = " — if the table is missing, migration 009_content_items.sql has not been applied yet";

export async function loadThreadItems(channelId: string, threadTs: string): Promise<ContentItem[]> {
  const { data, error } = await getSupabase()
    .from("content_items")
    .select(ITEM_COLS)
    .eq("slack_channel_id", channelId)
    .eq("slack_thread_ts", threadTs)
    .order("thread_index", { ascending: true });
  if (error) throw new Error(`content_items query failed: ${error.message}${MIGRATION_HINT}`);
  return (data ?? []).map(normalizeItem).filter((i): i is ContentItem => i !== null);
}

export async function loadItemByFileId(fileId: string): Promise<ContentItem | null> {
  const { data, error } = await getSupabase().from("content_items").select(ITEM_COLS).eq("slack_file_id", fileId).maybeSingle();
  if (error) throw new Error(`content_items query failed: ${error.message}${MIGRATION_HINT}`);
  return normalizeItem(data);
}

export async function loadItem(id: string): Promise<ContentItem | null> {
  const { data, error } = await getSupabase().from("content_items").select(ITEM_COLS).eq("id", id).maybeSingle();
  if (error) throw new Error(`content_items query failed: ${error.message}${MIGRATION_HINT}`);
  return normalizeItem(data);
}

export interface NewContentItem {
  id: string; // pre-generated: the Storage path needs it before the row exists
  ventureId: string;
  slackChannelId: string;
  slackThreadTs: string;
  slackFileId: string;
  fileName: string;
  threadIndex: number;
  sourceImageUrl: string | null;
  mediaUrl: string;
  status: "open" | "queued";
}

export async function insertItem(row: NewContentItem): Promise<ContentItem> {
  const { data, error } = await getSupabase()
    .from("content_items")
    .insert({
      id: row.id,
      venture_id: row.ventureId,
      content_type: "meme",
      slack_channel_id: row.slackChannelId,
      slack_thread_ts: row.slackThreadTs,
      slack_file_id: row.slackFileId,
      file_name: row.fileName,
      thread_index: row.threadIndex,
      source_image_url: row.sourceImageUrl,
      media_url: row.mediaUrl,
      status: row.status,
    })
    .select(ITEM_COLS)
    .single();
  if (error || !data) throw new Error(`content_items insert failed: ${error?.message ?? "no row returned"}${MIGRATION_HINT}`);
  const item = normalizeItem(data);
  if (!item) throw new Error("content_items insert returned an unreadable row");
  return item;
}

export interface ContentItemPatch {
  status?: ContentItemStatus;
  sourceKind?: "repost" | "riff" | "original" | null;
  sourceCredit?: string | null;
  imgflipTemplateId?: string | null;
  renderUrl?: string | null;
  captions?: Record<string, string>;
  error?: string | null;
}

export async function updateItem(id: string, patch: ContentItemPatch): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.sourceKind !== undefined) row.source_kind = patch.sourceKind;
  if (patch.sourceCredit !== undefined) row.source_credit = patch.sourceCredit;
  if (patch.imgflipTemplateId !== undefined) row.imgflip_template_id = patch.imgflipTemplateId;
  if (patch.renderUrl !== undefined) row.render_url = patch.renderUrl;
  if (patch.captions !== undefined) row.captions = patch.captions;
  if (patch.error !== undefined) row.error = patch.error;
  const { error } = await getSupabase().from("content_items").update(row).eq("id", id);
  if (error) throw new Error(`content_items update failed: ${error.message}`);
}
