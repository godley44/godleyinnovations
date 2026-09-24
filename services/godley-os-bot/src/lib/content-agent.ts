// The venture content agent — the in-thread collaborator for HIGH-TOUCH
// venture channels (ventures.interaction_mode, migration 008). Today's
// venture: #couplestherapy101. Flow per human message (the events route
// already acked Slack; everything here is post-200 background work):
//
//   1. Owner gate. Only OWNER_SLACK_USER_ID steers: anyone else gets one
//      read-only line inside an agent thread and is ignored elsewhere.
//      Owner unset = the agent is disabled (fail closed), said out loud.
//   2. Image drops (message subtype file_share): image files only; each is
//      downloaded with the bot token, mirrored to public Storage, and
//      recorded as a content_items row (deduped on the Slack file id). One
//      image → it becomes the thread's OPEN item and the model gives its
//      first read. Several → they are numbered and the owner picks by
//      number before any model call.
//   3. If this thread has a PENDING ACTION (a package waiting for "yes")
//      and the reply is an exact affirmative → file it (owner only), via the
//      shared filing path. Exact negative → drop it. Anything else → the
//      model, and the pending package stays armed until it expires or is
//      superseded.
//   4. Otherwise: model turn — the thread's history (conversations.replies
//      is the memory; no new table) + the open item's image + a code-built
//      context card, with the work tools (templates, render) looping and
//      the ACT tool (file_for_approval) NEVER executing: it is validated
//      (describeFiling), parked, and echoed as the final package for the
//      owner to confirm.
//
// The confirmation gate is enforced HERE, in code, exactly like the AI
// Manager's: executeFiling is reachable only from the affirmative-reply
// branch after PendingActionStore.take() returns a live entry. And even a
// filed package is only a PROPOSAL — publishing needs the approval buttons
// or the app inbox, the same gate as everything else. The agent never
// publishes.
//
// Every reply goes in the drop message's thread; nothing top-level.

import { randomUUID } from "node:crypto";
import type { AnthropicTool, ChatMessage, ContentBlock, ImageBlock, ModelReply, ToolResultBlock, ToolUseBlock } from "../integrations/anthropic.js";
import { callClaude, resolveModelId } from "../integrations/anthropic.js";
import { imgflipConfigured, listTemplates, renderMeme, type MemeTemplate } from "../integrations/imgflip.js";
import { classifyReply } from "./affirmative.js";
import { esc, image, type SlackBlock } from "./brief-blocks.js";
import {
  describeFiling,
  executeFiling,
  loadFilingContext,
  renderPackage,
  type ActDescription,
  type FilingContext,
  type FilingPackage,
  type FilingResult,
} from "./content-agent-acts.js";
import { buildContentAgentSystemPrompt } from "./content-agent-prompt.js";
import { CONTENT_AGENT_TOOLS, isContentActTool } from "./content-agent-tools.js";
import { insertItem, loadItemByFileId, loadThreadItems, updateItem, type ContentItem } from "./content-items.js";
import { extensionFor, isImageContentType, mirrorToStorage } from "./content-media.js";
import { describeTargetList } from "./content-publish.js";
import { recordContentFiling, recordContentImage, recordContentMessage, recordManagerError, recordModelCall, setPendingActionCount } from "./manager-state.js";
import { PendingActionStore, type PendingAction } from "./pending-actions.js";
import { downloadFile, fetchRecentMessages, postMessage, SlackFileScopeError, updateMessage, type SlackFileRef } from "./slack-web.js";
import { platformLabel } from "./social-blocks.js";
import type { Venture } from "./venture-map.js";

const CONTEXT_LIMIT = 20;
const MAX_MODEL_CALLS = 6;
const PLACEHOLDER_AFTER_MS = 5_000;
const THINKING_TEXT = "🤔 Looking…";
// Slack screenshots are a few MB; the vision providers cap an image near
// 5 MB, so anything bigger is refused with a "screenshot instead" instead
// of failing later in the model call.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TEMPLATE_LIST_MAX = 60;

export interface ContentAgentEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
  files: SlackFileRef[];
  venture: Venture;
}

export interface ContextMessage {
  fromBot: boolean;
  userId?: string;
  text: string;
}

export interface IngestArgs {
  venture: Venture;
  channel: string;
  threadTs: string;
  file: SlackFileRef;
  threadIndex: number;
  status: "open" | "queued";
}

// Every side effect is injected so the gating logic is unit-testable with
// fakes — the live wiring at the bottom of this file supplies the real ones.
export interface ContentAgentDeps {
  ownerId(): string | undefined;
  callModel(args: { system: string; messages: ChatMessage[]; tools: AnthropicTool[] }): Promise<ModelReply>;
  fetchContext(channel: string, threadTs: string, excludeTs: string, limit: number): Promise<ContextMessage[]>;
  postReply(channel: string, threadTs: string, text: string, blocks?: SlackBlock[]): Promise<string>;
  updateReply(channel: string, ts: string, text: string): Promise<void>;
  loadThreadItems(channel: string, threadTs: string): Promise<ContentItem[]>;
  loadItemByFileId(fileId: string): Promise<ContentItem | null>;
  ingestImage(args: IngestArgs): Promise<ContentItem>;
  setItemStatus(id: string, status: "open" | "queued"): Promise<void>;
  loadFilingContext(venture: Venture): Promise<FilingContext>;
  imgflipAvailable(): boolean;
  listTemplates(): Promise<MemeTemplate[]>;
  renderMeme(templateId: string, texts: string[]): Promise<{ url: string }>;
  executeFiling(pkg: FilingPackage): Promise<FilingResult>;
  now(): number;
}

// --- pure helpers (exported for tests) ---------------------------------------

function conversationKey(channel: string, rootTs: string): string {
  return `${channel}:${rootTs}`;
}

// "2", "#2", "image 2", "the second one", "do 2 first", "2 please" → 2.
// Anything longer or fuzzier is NOT a selection (a caption tweak that
// happens to start with a digit must never switch images).
const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5,
  sixth: 6, "6th": 6, seventh: 7, "7th": 7, eighth: 8, "8th": 8, ninth: 9, "9th": 9, tenth: 10, "10th": 10,
};

export function parseImageSelection(text: string, count: number): number | null {
  let t = text
    .replace(/<@[^>]+>/g, "")
    .toLowerCase()
    .replace(/[.!,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^(?:let'?s |lets )?(?:do|run|start with|go with|take|try|use|pick|open) /, "");
  t = t.replace(/^(?:the |image |img |number |no |#)+/, "");
  t = t.replace(/ (?:first|please|pls|one|next)$/, "").trim();
  if (t.length > 6) return null;
  const n = /^\d{1,2}$/.test(t) ? Number(t) : (ORDINALS[t] ?? null);
  if (n === null || n < 1 || n > count) return null;
  return n;
}

export function containsLink(text: string): boolean {
  return /https?:\/\/|<https?:|\b(?:reddit\.com|x\.com|twitter\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com)\b/i.test(text);
}

export interface ContextCardArgs {
  items: ContentItem[];
  active: ContentItem | null;
  filing: FilingContext;
  imgflipAvailable: boolean;
  justSelected: boolean; // the owner just picked this image → open with the first read
}

export function buildContextCard(args: ContextCardArgs): string {
  const lines = ["[Thread context — written by the system, not by Justin]"];
  const { active } = args;
  if (!active) {
    if (args.items.length === 0) {
      lines.push("No image in this thread yet. Ask for a screenshot; links are out of scope.");
    } else {
      lines.push("No image is open right now. Images in this thread:");
      for (const i of args.items) lines.push(`  ${i.threadIndex}) ${i.fileName ?? "image"} — ${i.status}`);
      lines.push("Justin picks a queued one by number; a proposed one is already filed.");
    }
  } else {
    lines.push(
      `Open item: ${active.id} · image ${active.threadIndex} of ${args.items.length}${active.fileName ? ` (${active.fileName})` : ""} · status: ${active.status}`,
    );
    if (args.justSelected) lines.push("Justin just picked this image — open with the standard first read (joke mechanics, format, handle, repost or riff?).");
    const decided: string[] = [];
    decided.push(active.sourceKind ? `source_kind: ${active.sourceKind}` : "repost/riff: not decided yet");
    decided.push(active.sourceCredit ? `credit on file: ${active.sourceCredit}` : "credit: none recorded yet");
    if (active.imgflipTemplateId) decided.push(`Imgflip template: ${active.imgflipTemplateId}`);
    lines.push(`Decided so far: ${decided.join(" · ")}`);
    const others = args.items.filter((i) => i.id !== active.id);
    if (others.length > 0) {
      lines.push(`Other images in this thread: ${others.map((i) => `${i.threadIndex}) ${i.fileName ?? "image"} — ${i.status}`).join("; ")}`);
    }
  }
  lines.push(`Imgflip riffs: ${args.imgflipAvailable ? "available" : "NOT configured — repost only; riffs need IMGFLIP_USERNAME/IMGFLIP_PASSWORD"}`);
  const targets = [args.filing.source, ...args.filing.crossTargets].map((v) => ({
    name: v.name,
    platforms: v.platforms.length > 0 ? v.platforms : ["(no Instagram/Facebook configured yet)"],
  }));
  lines.push(`Publishes to: ${describeTargetList(targets, platformLabel)}`);
  if (args.filing.cta) {
    const c = args.filing.cta;
    lines.push(
      c.due
        ? `${c.targetName} CTA: DUE on this post (${c.publishedCount} published so far — this would be #${c.publishedCount + 1}). Pass cta_line when filing.`
        : `${c.targetName} CTA: not due (${c.publishedCount} published so far — this would be #${c.publishedCount + 1}). Pass no cta_line.`,
    );
  }
  return lines.join("\n");
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function buildModelMessages(
  context: ContextMessage[],
  event: { user: string; text: string; files: SlackFileRef[] },
  attach: { imageUrl: string | null; card: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const m of context) {
    const text = m.text.trim();
    if (!text) continue;
    if (m.fromBot) messages.push({ role: "assistant", content: text });
    else messages.push({ role: "user", content: `${m.userId ? `<@${m.userId}>: ` : ""}${text}` });
  }
  const said = event.text.trim() || (event.files.length > 0 ? "(dropped an image)" : "");
  const blocks: (ContentBlock | ImageBlock)[] = [{ type: "text", text: `<@${event.user}>: ${said}`.trim() }];
  if (attach.imageUrl) blocks.push({ type: "image", source: { type: "url", url: attach.imageUrl } });
  blocks.push({ type: "text", text: attach.card });
  messages.push({ role: "user", content: blocks });
  // The API requires the first message to be a user turn.
  while (messages.length > 0 && messages[0]!.role === "assistant") messages.shift();
  return messages;
}

function renderFilingConfirmation(pkg: FilingPackage, superseded: PendingAction | null): { text: string; blocks: SlackBlock[] } {
  const rendered = renderPackage(pkg);
  const supersedeNote = superseded ? `\n_(This replaces the earlier package waiting for confirmation — that one is off the table.)_` : "";
  const ask =
    "Reply *yes* to file it for approval (Approve/Reject buttons then land in this thread; nothing publishes until you approve) " +
    `or *no* to drop it — this expires in 10 minutes.${supersedeNote}`;
  return {
    text: `${rendered.text}\n${ask}`,
    blocks: [...rendered.blocks, { type: "section", text: { type: "mrkdwn", text: ask } }],
  };
}

export function renderFilingOutcome(pkg: FilingPackage, result: FilingResult): string {
  const dry = Object.entries(result.dryRunByVenture)
    .filter(([, isDry]) => isDry)
    .map(([slug]) => slug);
  const dryNote =
    dry.length > 0
      ? `\n🧪 Dry run for: ${dry.join(", ")} — no real Blotato key for ${dry.length === 1 ? "that venture" : "those ventures"} yet, so the executor will log the exact requests and publish nothing there.`
      : "";
  return (
    `✅ Filed for approval — proposal \`${result.proposalId}\` (${pkg.venture_name}: ${describeTargetList(pkg.targets, platformLabel)}).\n` +
    "Approve/Reject buttons land in this thread within a minute (or approve it in the app inbox). Publishing happens only after that." +
    dryNote
  );
}

// --- the agent ---------------------------------------------------------------

export function createContentAgent(deps: ContentAgentDeps) {
  const store = new PendingActionStore(deps.now);

  function fileNameOf(f: SlackFileRef): string {
    return f.name || f.id;
  }

  async function replyOwnerOnly(event: ContentAgentEvent, rootTs: string, configured: boolean): Promise<void> {
    await deps.postReply(
      event.channel,
      rootTs,
      configured
        ? "🔒 Only Justin can steer this thread — nothing was changed."
        : "🔒 OWNER_SLACK_USER_ID is not set, so the content agent is disabled (fail closed). Set it in the vault, then drop the image again. Nothing was changed.",
    );
  }

  // Image drops → content items. Returns the item that should drive this
  // turn's model call (a single fresh image with no open item), or null
  // when the reply was already given (dedupes, multi-image numbering,
  // refusals) and the turn is over.
  async function ingestDrop(event: ContentAgentEvent, rootTs: string, items: ContentItem[]): Promise<{ item: ContentItem; items: ContentItem[] } | null> {
    const images = event.files.filter((f) => isImageContentType(f.mimetype));
    if (images.length === 0) {
      await deps.postReply(event.channel, rootTs, "I can only work from image files (PNG/JPG/GIF/WebP) — send a screenshot of the meme.");
      return null;
    }
    const fresh: SlackFileRef[] = [];
    for (const f of images) {
      const existing = await deps.loadItemByFileId(f.id);
      if (existing) {
        await deps.postReply(
          event.channel,
          rootTs,
          `That image is already in play as image ${existing.threadIndex} of its thread (status: ${existing.status}) — I won't start it twice.`,
        );
      } else {
        fresh.push(f);
      }
    }
    if (fresh.length === 0) return null;
    const tooBig = fresh.find((f) => f.size !== null && f.size > MAX_IMAGE_BYTES);
    if (tooBig) {
      await deps.postReply(event.channel, rootTs, `${fileNameOf(tooBig)} is over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB — send a screenshot instead of the original.`);
      return null;
    }

    const alreadyOpen = items.some((i) => i.status === "open");
    const single = fresh.length === 1 && items.length === 0;
    const created: ContentItem[] = [];
    try {
      for (const [n, f] of fresh.entries()) {
        const item = await deps.ingestImage({
          venture: event.venture,
          channel: event.channel,
          threadTs: rootTs,
          file: f,
          threadIndex: items.length + n + 1,
          status: single ? "open" : "queued",
        });
        recordContentImage();
        created.push(item);
      }
    } catch (err) {
      if (err instanceof SlackFileScopeError) {
        await deps.postReply(
          event.channel,
          rootTs,
          `⚠️ I can't download images yet: ${err.message}. WHAT JUSTIN DOES: api.slack.com/apps → this app → OAuth & Permissions → add the *files:read* bot scope → Reinstall to Workspace. Then drop the image again.`,
        );
        return null;
      }
      const message = err instanceof Error ? err.message : String(err);
      recordManagerError(message);
      await deps.postReply(event.channel, rootTs, `⚠️ I couldn't store that image: ${message}. Nothing was filed.`);
      return null;
    }

    if (single) return { item: created[0]!, items: created };
    const all = [...items, ...created];
    const listing = all.map((i) => `${i.threadIndex}) ${i.fileName ?? "image"} — ${i.status === "open" ? "open now" : i.status}`).join("\n");
    await deps.postReply(
      event.channel,
      rootTs,
      alreadyOpen
        ? `Added ${created.length === 1 ? "it" : `${created.length} images`} to this thread:\n${listing}\nWe're still on the open one — reply with a number when you want to switch.`
        : `I see ${all.length} images:\n${listing}\nWhich one first? Reply with a number.`,
    );
    return null;
  }

  // Number replies pick a queued image (code-only, no model call).
  async function trySelection(event: ContentAgentEvent, rootTs: string, items: ContentItem[]): Promise<ContentItem | null | "asked"> {
    const queued = items.filter((i) => i.status === "queued");
    if (queued.length === 0) return null;
    const open = items.find((i) => i.status === "open") ?? null;
    const pick = parseImageSelection(event.text, items.length);
    if (pick === null) {
      if (open) return null; // a normal message about the open image
      await deps.postReply(event.channel, rootTs, `Which image first? Reply with a number (1–${items.length}).`);
      return "asked";
    }
    const chosen = items.find((i) => i.threadIndex === pick)!;
    if (chosen.status === "open") return chosen;
    if (chosen.status !== "queued") {
      await deps.postReply(event.channel, rootTs, `Image ${pick} is already ${chosen.status} — pick a queued one: ${queued.map((i) => i.threadIndex).join(", ")}.`);
      return "asked";
    }
    if (open) await deps.setItemStatus(open.id, "queued");
    await deps.setItemStatus(chosen.id, "open");
    return { ...chosen, status: "open" };
  }

  // The ONLY place a model ACT request goes: validate → park → ask. Never
  // executes anything.
  async function proposeFiling(
    key: string,
    toolUses: ToolUseBlock[],
    active: ContentItem | null,
    filing: FilingContext,
  ): Promise<{ text: string; blocks?: SlackBlock[] }> {
    if (!active) return { text: "⚠️ There is no open image in this thread to file — drop a screenshot first. Nothing is pending." };
    if (toolUses.length > 1) return { text: "⚠️ One package at a time — I got several file requests in one reply. Nothing is pending; say which one to file." };
    const described: ActDescription = describeFiling(toolUses[0]!.input, active, filing);
    if (!described.ok) return { text: `⚠️ I can't file that yet:\n• ${described.problem}\nNothing is pending.` };
    const { superseded } = store.propose(key, [described.act]);
    setPendingActionCount(store.count());
    return renderFilingConfirmation(described.act.input as unknown as FilingPackage, superseded);
  }

  async function runWorkTool(event: ContentAgentEvent, rootTs: string, name: string, input: Record<string, unknown>): Promise<string> {
    if (name === "list_meme_templates") {
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const all = await deps.listTemplates();
      const matches = (query ? all.filter((t) => t.name.toLowerCase().includes(query)) : all).slice(0, TEMPLATE_LIST_MAX);
      return JSON.stringify({
        imgflip_available: deps.imgflipAvailable(),
        count: matches.length,
        templates: matches.map((t) => ({ id: t.id, name: t.name, box_count: t.boxCount })),
      });
    }
    if (name === "render_meme") {
      if (!deps.imgflipAvailable()) {
        throw new Error("Imgflip credentials are not set — riffs are unavailable; offer a repost, and say riffs need IMGFLIP_USERNAME/IMGFLIP_PASSWORD");
      }
      const templateId = typeof input.template_id === "string" ? input.template_id.trim() : "";
      const texts = Array.isArray(input.texts) ? input.texts.filter((t): t is string => typeof t === "string") : [];
      if (!templateId || texts.length === 0) throw new Error("render_meme needs template_id and at least one text");
      const templates = await deps.listTemplates();
      const template = templates.find((t) => t.id === templateId);
      const { url } = await deps.renderMeme(templateId, texts);
      const label = template ? template.name : `template ${templateId}`;
      await deps.postReply(event.channel, rootTs, `🖼️ Riff preview — ${label}: ${url}`, [
        image(url, `Riff preview — ${label}`, `Riff preview — ${label}`),
        { type: "context", elements: [{ type: "mrkdwn", text: `Rendered with Imgflip · ${esc(url)} · a preview, not a post` }] },
      ]);
      return JSON.stringify({ url, template_id: templateId, template_name: label, posted_in_thread: true, note: "use this exact url as render_url when filing" });
    }
    throw new Error(`not a work tool: ${name}`);
  }

  async function modelTurn(event: ContentAgentEvent, rootTs: string, key: string, items: ContentItem[], active: ContentItem | null, justSelected: boolean): Promise<void> {
    const placeholder: { ts: string | null; promise: Promise<void> | null } = { ts: null, promise: null };
    const timer = setTimeout(() => {
      placeholder.promise = deps
        .postReply(event.channel, rootTs, THINKING_TEXT)
        .then((ts) => {
          placeholder.ts = ts;
        })
        .catch((err) => console.error("[content-agent] placeholder post failed:", err));
    }, PLACEHOLDER_AFTER_MS);

    const deliver = async (text: string, blocks?: SlackBlock[]): Promise<void> => {
      clearTimeout(timer);
      if (placeholder.promise) await placeholder.promise;
      if (placeholder.ts && !blocks) {
        try {
          await deps.updateReply(event.channel, placeholder.ts, text);
          return;
        } catch (err) {
          console.error("[content-agent] chat.update of the placeholder failed, posting fresh:", err);
        }
      } else if (placeholder.ts) {
        // Blocks can't ride a chat.update here; retire the placeholder text.
        await deps.updateReply(event.channel, placeholder.ts, "…").catch(() => undefined);
      }
      await deps.postReply(event.channel, rootTs, text, blocks);
    };

    try {
      const filing = await deps.loadFilingContext(event.venture);
      const imgflipAvailable = deps.imgflipAvailable();
      const system = buildContentAgentSystemPrompt({
        ventureName: event.venture.name,
        ventureSlug: event.venture.slug,
        voicePrompt: event.venture.voicePrompt,
        crossTargets: filing.crossTargets.map((t) => ({ slug: t.slug, name: t.name })),
        imgflipAvailable,
      });
      const context = await deps.fetchContext(event.channel, rootTs, event.ts, CONTEXT_LIMIT);
      const card = buildContextCard({ items, active, filing, imgflipAvailable, justSelected });
      const messages = buildModelMessages(context, event, { imageUrl: active?.status === "open" ? active.mediaUrl : null, card });

      for (let call = 0; call < MAX_MODEL_CALLS; call++) {
        const reply = await deps.callModel({ system, messages, tools: CONTENT_AGENT_TOOLS });
        recordModelCall(reply.latencyMs);

        const toolUses = reply.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        const actUses = toolUses.filter((t) => isContentActTool(t.name));
        if (actUses.length > 0) {
          // Confirm-before-file: the model turn ends here, unexecuted.
          const ask = await proposeFiling(key, actUses, active, filing);
          await deliver(ask.text, ask.blocks);
          return;
        }
        if (reply.stopReason === "tool_use" && toolUses.length > 0) {
          messages.push({ role: "assistant", content: reply.content });
          const results: ToolResultBlock[] = [];
          for (const t of toolUses) {
            try {
              results.push({ type: "tool_result", tool_use_id: t.id, content: await runWorkTool(event, rootTs, t.name, t.input) });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              results.push({ type: "tool_result", tool_use_id: t.id, content: `Error: ${message}`, is_error: true });
            }
          }
          messages.push({ role: "user", content: results });
          continue;
        }
        await deliver(textOf(reply.content) || "(The model returned an empty reply — try rephrasing.)");
        return;
      }
      await deliver(`⚠️ I stopped after ${MAX_MODEL_CALLS} tool rounds without a final answer — tell me what to do next in one line.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordManagerError(message);
      console.error(`[content-agent] turn failed: ${message}`);
      await deliver(`⚠️ The content agent hit an error: ${message}`);
    }
  }

  async function handleEvent(event: ContentAgentEvent): Promise<void> {
    recordContentMessage();
    const rootTs = event.threadTs ?? event.ts;
    const key = conversationKey(event.channel, rootTs);
    const ownerId = deps.ownerId();
    const isOwner = ownerId !== undefined && event.user === ownerId;

    let items = await deps.loadThreadItems(event.channel, rootTs);

    if (!isOwner) {
      // Read-only for everyone else: one line inside an agent thread or on a
      // file drop; silence elsewhere (a hands-off-style channel chat).
      if (items.length > 0 || event.files.length > 0) await replyOwnerOnly(event, rootTs, ownerId !== undefined);
      return;
    }

    let justSelected = false;
    if (event.files.length > 0) {
      const ingested = await ingestDrop(event, rootTs, items);
      if (!ingested) return;
      items = ingested.items;
      justSelected = true;
    }

    const intent = classifyReply(event.text);
    const lookup = store.peek(key);
    setPendingActionCount(store.count());

    if (lookup.state === "expired") {
      await deps.postReply(event.channel, rootTs, "⌛ The package waiting for confirmation expired after 10 minutes — nothing was filed. Say *send it* again if you still want it.");
      if (intent !== "other") return;
    }
    if (lookup.state === "pending" && event.files.length === 0) {
      if (intent === "affirmative") {
        const action = store.take(key);
        setPendingActionCount(store.count());
        if (!action) return; // raced with expiry — announced next time
        const pkg = action.acts[0]!.input as unknown as FilingPackage;
        try {
          const result = await deps.executeFiling(pkg);
          recordContentFiling();
          await deps.postReply(event.channel, rootTs, renderFilingOutcome(pkg, result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordManagerError(message);
          await deps.postReply(event.channel, rootTs, `❌ Filing failed: ${message}\nNothing was filed — fix the cause and say *send it* again.`);
        }
        return;
      }
      if (intent === "negative") {
        store.cancel(key);
        setPendingActionCount(store.count());
        await deps.postReply(event.channel, rootTs, "🚫 Dropped — nothing was filed. Keep editing, or say *send it* when the package is right.");
        return;
      }
      // Anything ambiguous falls through to the model; the package stays
      // armed until TTL or supersession.
    }

    let active = items.find((i) => i.status === "open") ?? null;
    if (event.files.length === 0) {
      const selected = await trySelection(event, rootTs, items);
      if (selected === "asked") return;
      if (selected && selected.id !== active?.id) {
        justSelected = true;
        items = items.map((i) => (i.id === selected.id ? selected : i.status === "open" ? { ...i, status: "queued" as const } : i));
        active = selected;
      }
      if (!active && items.length === 0 && containsLink(event.text)) {
        await deps.postReply(event.channel, rootTs, "Links are out of scope for me (Reddit/X/YouTube) — send a screenshot of the meme and I'll take it from there.");
        return;
      }
    }

    await modelTurn(event, rootTs, key, items, active, justSelected);
  }

  return { handleEvent };
}

// --- Live wiring ------------------------------------------------------------

function liveDeps(): ContentAgentDeps {
  return {
    ownerId: () => {
      const id = process.env.OWNER_SLACK_USER_ID?.trim();
      return id ? id : undefined;
    },
    callModel: (args) => callClaude({ ...args, model: resolveModelId(process.env.CONTENT_AGENT_MODEL), label: "content-agent", maxTokens: 1500 }),
    fetchContext: async (channel, threadTs, excludeTs, limit) => {
      const history = await fetchRecentMessages({ channel, threadTs, limit: limit + 5 });
      return history
        .filter((m) => m.ts !== excludeTs && (!m.subtype || m.subtype === "bot_message" || m.subtype === "file_share"))
        .map((m) => ({
          fromBot: m.botId !== undefined || m.subtype === "bot_message",
          userId: m.userId,
          text: m.text.trim() || (m.subtype === "file_share" ? "(dropped an image)" : ""),
        }))
        .filter((m) => m.text !== "")
        .slice(-limit);
    },
    postReply: (channel, threadTs, text, blocks) => postMessage({ channel, threadTs, text, blocks }),
    updateReply: (channel, ts, text) => updateMessage({ channel, ts, text }),
    loadThreadItems,
    loadItemByFileId,
    ingestImage: async (args) => {
      if (!args.file.urlPrivateDownload) throw new Error(`Slack sent no download url for ${args.file.name}`);
      const id = randomUUID();
      const { bytes, contentType } = await downloadFile(args.file.urlPrivateDownload);
      const type = isImageContentType(contentType) ? contentType.split(";")[0]!.trim() : args.file.mimetype;
      const ext = extensionFor(type);
      if (!ext) throw new Error(`${args.file.name} is not an image I can use (${type || "unknown type"})`);
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`${args.file.name} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
      const mirrored = await mirrorToStorage({
        ventureSlug: args.venture.slug,
        contentItemId: id,
        fileName: `source.${ext}`,
        contentType: type,
        bytes,
      });
      return insertItem({
        id,
        ventureId: args.venture.id,
        slackChannelId: args.channel,
        slackThreadTs: args.threadTs,
        slackFileId: args.file.id,
        fileName: args.file.name,
        threadIndex: args.threadIndex,
        sourceImageUrl: args.file.urlPrivateDownload,
        mediaUrl: mirrored.publicUrl,
        status: args.status,
      });
    },
    setItemStatus: (id, status) => updateItem(id, { status }),
    loadFilingContext,
    imgflipAvailable: imgflipConfigured,
    listTemplates,
    renderMeme: async (templateId, texts) => ({ url: (await renderMeme(templateId, texts)).url }),
    executeFiling,
    now: Date.now,
  };
}

let liveAgent: ReturnType<typeof createContentAgent> | null = null;

export async function handleContentAgentEvent(event: ContentAgentEvent): Promise<void> {
  liveAgent ??= createContentAgent(liveDeps());
  await liveAgent.handleEvent(event);
}
