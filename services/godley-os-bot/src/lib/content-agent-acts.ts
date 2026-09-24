// The content agent's one ACT — file_for_approval — in its two halves:
//
//  describeFiling (PURE): at proposal time, validate the model's tool input
//  against the thread's item and the publish plan, and build the exact
//  package the owner confirms: preview image, one caption per venture, the
//  target list, the credit. Code-built from database rows and the owner's
//  own words, never model prose — what he confirms is what gets filed.
//
//  executeFiling (I/O): at confirmation time ("yes"), mirror a riff's render
//  into Storage, then file the post through fileSocialDraft — THE shared
//  filing path (the admin route and the manager use the same function) —
//  and mark the item 'proposed'. Filing never publishes: the proposal it
//  creates still needs the owner's approval (buttons in the thread, or the
//  app inbox), and only apply_proposal() + the executor publish.

import { isDryRun } from "../integrations/blotato.js";
import { downloadRender, IMGFLIP_IMAGE_HOST_RE } from "../integrations/imgflip.js";
import { esc, image, section, type SlackBlock } from "./brief-blocks.js";
import { CAPTION_MAX_CHARS } from "./content-agent-tools.js";
import { loadItem, updateItem, type ContentItem } from "./content-items.js";
import { extensionFor, mirrorToStorage } from "./content-media.js";
import {
  CONTENT_PLATFORMS,
  composeCaptions,
  ctaDueForNextPost,
  describeTargetList,
  normalizeHandle,
} from "./content-publish.js";
import { fileSocialDraft } from "./file-social-draft.js";
import type { ProposedAct } from "./pending-actions.js";
import { platformLabel } from "./social-blocks.js";
import { getSupabase } from "./supabase.js";
import type { Venture } from "./venture-map.js";

export type ActDescription = { ok: true; act: ProposedAct } | { ok: false; problem: string };

// One venture in the publish plan with the content platforms it has enabled.
export interface PlanVenture {
  id: string;
  slug: string;
  name: string;
  platforms: string[];
}

// Everything the agent needs to know about where this venture's memes go,
// loaded once per turn (it also feeds the model's thread-context card).
export interface FilingContext {
  source: PlanVenture;
  crossTargets: PlanVenture[];
  // The CTA rule applies to the (first) cross-publish venture: null when
  // there is none.
  cta: { targetSlug: string; targetName: string; due: boolean; publishedCount: number } | null;
}

// The normalized act input — stored in the pending action and executed
// verbatim after "yes".
export interface FilingPackage {
  content_item_id: string;
  venture_slug: string;
  venture_name: string;
  source_kind: "repost" | "riff";
  source_credit: string | null;
  imgflip_template_id: string | null;
  render_url: string | null; // riff: the i.imgflip.com render, mirrored at execution
  preview_url: string; // what the confirmation shows and what publishes (pre-mirror for a riff)
  captions: Record<string, string>;
  targets: { slug: string; name: string; platforms: string[] }[];
  cta_line: string | null;
  cta_due: boolean;
  slack_channel_id: string;
  slack_thread_ts: string;
}

const CTA_MAX_CHARS = 300;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function describeFiling(raw: Record<string, unknown>, item: ContentItem, ctx: FilingContext): ActDescription {
  if (item.status !== "open") {
    return { ok: false, problem: `this image is already ${item.status} — nothing more to file for it` };
  }
  const sourceKind = raw.source_kind === "repost" || raw.source_kind === "riff" ? raw.source_kind : null;
  if (!sourceKind) return { ok: false, problem: 'file_for_approval needs source_kind: "repost" or "riff"' };

  const caption = str(raw.caption);
  if (!caption) return { ok: false, problem: "file_for_approval needs the final caption" };
  if (caption.length > CAPTION_MAX_CHARS) {
    return { ok: false, problem: `the caption is ${caption.length} characters — Instagram caps captions at ${CAPTION_MAX_CHARS}` };
  }

  const credit = normalizeHandle(str(raw.source_credit) || item.sourceCredit);
  let templateId: string | null = null;
  let renderUrl: string | null = null;
  let previewUrl: string;
  if (sourceKind === "repost") {
    if (!credit) {
      return {
        ok: false,
        problem: "a repost needs the creator's handle for the credit line (source_credit, e.g. \"@templarpilled\") — if none is visible, ask Justin for the source first",
      };
    }
    if (!item.mediaUrl) return { ok: false, problem: "this image has no public mirror yet — drop it again" };
    previewUrl = item.mediaUrl;
  } else {
    templateId = str(raw.imgflip_template_id) || null;
    renderUrl = str(raw.render_url) || null;
    if (!templateId) return { ok: false, problem: "a riff needs imgflip_template_id (the template you rendered)" };
    if (!renderUrl || !IMGFLIP_IMAGE_HOST_RE.test(renderUrl)) {
      return { ok: false, problem: "a riff needs render_url — the exact i.imgflip.com url a render_meme call returned" };
    }
    previewUrl = renderUrl;
  }

  let ctaLine: string | null = null;
  const ctaDue = ctx.cta?.due === true;
  if (ctaDue) {
    ctaLine = str(raw.cta_line) || null;
    if (!ctaLine) {
      return {
        ok: false,
        problem:
          `the ${ctx.cta!.targetName} CTA is due on this post (${ctx.cta!.publishedCount} published so far — this is #${ctx.cta!.publishedCount + 1}): ` +
          "write one fresh one-line invitation to check out @CouplesTherapy101 as cta_line and call again",
      };
    }
    if (ctaLine.length > CTA_MAX_CHARS) return { ok: false, problem: `the cta_line is too long (${ctaLine.length} chars, max ${CTA_MAX_CHARS})` };
  }

  if (ctx.source.platforms.length === 0) {
    return {
      ok: false,
      problem:
        `${ctx.source.name} has no enabled Instagram/Facebook row in venture_platforms — ` +
        `ask Justin to run "sync blotato accounts for ${ctx.source.slug}" in #studio-admin first`,
    };
  }

  const targets = [ctx.source, ...ctx.crossTargets].map((v) => ({ slug: v.slug, name: v.name, platforms: v.platforms }));
  const captions = composeCaptions({
    sourceSlug: ctx.source.slug,
    targetSlugs: ctx.crossTargets.map((t) => t.slug),
    caption,
    credit,
    sourceKind,
    ctaDue,
    ctaLine,
  });

  const pkg: FilingPackage = {
    content_item_id: item.id,
    venture_slug: ctx.source.slug,
    venture_name: ctx.source.name,
    source_kind: sourceKind,
    source_credit: credit,
    imgflip_template_id: templateId,
    render_url: renderUrl,
    preview_url: previewUrl,
    captions,
    targets,
    cta_line: ctaDue ? ctaLine : null,
    cta_due: ctaDue,
    slack_channel_id: item.slackChannelId,
    slack_thread_ts: item.slackThreadTs,
  };
  return {
    ok: true,
    act: { tool: "file_for_approval", input: pkg as unknown as Record<string, unknown>, summary: packageSummaryLine(pkg) },
  };
}

export function packageSummaryLine(pkg: FilingPackage): string {
  const how = pkg.source_kind === "repost" ? `repost via ${pkg.source_credit}` : `riff on Imgflip template ${pkg.imgflip_template_id}`;
  return `File for approval — ${pkg.venture_name} ${how} → ${describeTargetList(pkg.targets, platformLabel)}`;
}

// The confirmation echo: image, every venture's caption, the target list.
export function renderPackage(pkg: FilingPackage): { text: string; blocks: SlackBlock[] } {
  const fence = (t: string) => `\`\`\`\n${esc(t.replace(/`/g, "'"))}\n\`\`\``;
  const lines: string[] = [];
  for (const t of pkg.targets) {
    const platforms = t.platforms.length > 0 ? t.platforms.map(platformLabel).join(", ") : "⚠️ no Instagram/Facebook configured yet — each platform will fail loudly until the account sync runs";
    lines.push(`*${esc(t.name)}* → ${esc(platforms)}\n${fence(pkg.captions[t.slug] ?? pkg.captions[pkg.venture_slug] ?? "")}`);
  }
  const how =
    pkg.source_kind === "repost"
      ? `repost · credit ${esc(pkg.source_credit ?? "")}`
      : `riff · Imgflip template ${esc(pkg.imgflip_template_id ?? "")}${pkg.source_credit ? ` · inspired by ${esc(pkg.source_credit)}` : ""}`;
  const cta = pkg.cta_due ? " · CTA line included (every-3rd-post rule)" : "";
  const blocks: SlackBlock[] = [
    section(`📦 *Ready to file for approval — ${esc(pkg.venture_name)}*`),
    image(pkg.preview_url, `${pkg.venture_name} ${pkg.source_kind}`),
    section(lines.join("\n")),
    section(`_${how}${cta}_`),
  ];
  return { text: `Ready to file for approval — ${packageSummaryLine(pkg)}`, blocks };
}

// --- I/O: the publish plan --------------------------------------------------

function enabledContentPlatforms(rows: Record<string, unknown>[], ventureId: string): string[] {
  return CONTENT_PLATFORMS.filter((p) =>
    rows.some((r) => r.venture_id === ventureId && r.platform === p && r.enabled === true),
  );
}

export async function loadFilingContext(venture: Venture): Promise<FilingContext> {
  const supabase = getSupabase();
  const { data: xData, error: xError } = await supabase
    .from("venture_cross_publish")
    .select("target_slug, content_type")
    .eq("source_slug", venture.slug)
    .eq("content_type", "meme");
  if (xError) throw new Error(`venture_cross_publish query failed: ${xError.message} — migration 009 applied?`);
  const targetSlugs = [...new Set((xData ?? []).map((r) => (r as { target_slug?: unknown }).target_slug).filter((s): s is string => typeof s === "string"))];

  const { data: vData, error: vError } = await supabase.from("ventures").select("id, slug, name").in("slug", [venture.slug, ...targetSlugs]);
  if (vError) throw new Error(`ventures query failed: ${vError.message}`);
  const ventures = (vData ?? []).map((r) => r as { id: string; slug: string; name: string });
  const ventureIds = ventures.map((v) => v.id);

  const { data: pData, error: pError } = await supabase
    .from("venture_platforms")
    .select("venture_id, platform, enabled")
    .in("venture_id", ventureIds);
  if (pError) throw new Error(`venture_platforms query failed: ${pError.message}`);
  const rows = (pData ?? []).map((r) => r as Record<string, unknown>);

  const plan = (v: { id: string; slug: string; name: string }): PlanVenture => ({
    id: v.id,
    slug: v.slug,
    name: v.name,
    platforms: enabledContentPlatforms(rows, v.id),
  });
  const source = plan({ id: venture.id, slug: venture.slug, name: venture.name });
  const crossTargets = targetSlugs.map((slug) => ventures.find((v) => v.slug === slug)).filter((v): v is { id: string; slug: string; name: string } => v !== undefined).map(plan);

  let cta: FilingContext["cta"] = null;
  const first = crossTargets[0];
  if (first) {
    // Published POSTS, not ledger rows: a post publishing to Instagram and
    // Facebook is one post. Distinct calendar ids among the venture's
    // 'published' ledger rows.
    const { data: sData, error: sError } = await supabase
      .from("social_publishes")
      .select("calendar_id")
      .eq("venture_id", first.id)
      .eq("status", "published")
      .limit(1000);
    if (sError) throw new Error(`social_publishes query failed: ${sError.message}`);
    const publishedCount = new Set((sData ?? []).map((r) => (r as { calendar_id?: unknown }).calendar_id)).size;
    cta = { targetSlug: first.slug, targetName: first.name, due: ctaDueForNextPost(publishedCount), publishedCount };
  }
  return { source, crossTargets, cta };
}

// --- I/O: execution ---------------------------------------------------------

export interface FilingResult {
  proposalId: string;
  calendarId: string;
  publishMediaUrl: string;
  dryRunByVenture: Record<string, boolean>;
}

export async function executeFiling(pkg: FilingPackage): Promise<FilingResult> {
  const item = await loadItem(pkg.content_item_id);
  if (!item) throw new Error(`content item ${pkg.content_item_id} no longer exists`);
  if (item.status !== "open") throw new Error(`this image is already ${item.status} — nothing was filed`);

  // A riff publishes from OUR copy of the render, never from Imgflip's
  // hosting (mirrored now, so the approval preview is the exact asset).
  let publishMediaUrl: string;
  let renderUrl: string | null = null;
  if (pkg.source_kind === "riff") {
    const render = await downloadRender(pkg.render_url!);
    const ext = extensionFor(render.contentType) ?? "jpg";
    const mirrored = await mirrorToStorage({
      ventureSlug: pkg.venture_slug,
      contentItemId: item.id,
      fileName: `riff.${ext}`,
      contentType: render.contentType,
      bytes: render.bytes,
    });
    renderUrl = mirrored.publicUrl;
    publishMediaUrl = mirrored.publicUrl;
  } else {
    if (!item.mediaUrl) throw new Error("the image has no public mirror — drop it again");
    publishMediaUrl = item.mediaUrl;
  }

  const source = pkg.targets.find((t) => t.slug === pkg.venture_slug);
  const platforms = source?.platforms ?? [];
  const filed = await fileSocialDraft(
    pkg.venture_slug,
    { text: pkg.captions[pkg.venture_slug], platforms, mediaUrls: [publishMediaUrl] },
    {
      kind: "image",
      contentItemId: item.id,
      captions: pkg.captions,
      proposedBy: "content-agent",
      payloadExtras: {
        contentType: item.contentType,
        contentItemId: item.id,
        captions: pkg.captions,
        targets: pkg.targets,
        sourceKind: pkg.source_kind,
        credit: pkg.source_credit,
        slack_channel_id: pkg.slack_channel_id,
        slack_thread_ts: pkg.slack_thread_ts,
      },
    },
  );
  if (!filed.ok) throw new Error(filed.error);

  await updateItem(item.id, {
    status: "proposed",
    sourceKind: pkg.source_kind,
    sourceCredit: pkg.source_credit,
    imgflipTemplateId: pkg.imgflip_template_id,
    renderUrl,
    captions: pkg.captions,
  });

  const dryRunByVenture: Record<string, boolean> = {};
  for (const t of pkg.targets) dryRunByVenture[t.slug] = isDryRun(t.slug);
  return { proposalId: filed.proposalId, calendarId: filed.calendarId, publishMediaUrl, dryRunByVenture };
}
