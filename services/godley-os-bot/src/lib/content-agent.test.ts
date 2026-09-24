// The content agent's gates, pinned in code: only the owner steers; image
// drops become items (deduped, numbered when several); the model's
// file_for_approval NEVER files anything — only the owner's exact "yes"
// against a live pending package does, through the injected filing path;
// and the pure helpers (selection parsing, the context card, the package
// validation) behave. All side effects are faked; nothing here talks to
// Slack, Supabase, Imgflip, or a model.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelReply } from "../integrations/anthropic.js";
import { describeFiling, type FilingContext, type FilingPackage } from "./content-agent-acts.js";
import {
  buildContextCard,
  buildModelMessages,
  containsLink,
  createContentAgent,
  parseImageSelection,
  type ContentAgentDeps,
  type ContentAgentEvent,
} from "./content-agent.js";
import type { ContentItem } from "./content-items.js";
import { PENDING_ACTION_TTL_MS } from "./pending-actions.js";
import { SlackFileScopeError, type SlackFileRef } from "./slack-web.js";
import type { Venture } from "./venture-map.js";

const OWNER = "U_OWNER";
const CT101: Venture = {
  id: "v-ct",
  name: "CouplesTherapy101",
  slug: "couplestherapy101",
  status: "active",
  interactionMode: "high_touch",
  voicePrompt: "Find the absurdity → uncover the wisdom → point toward hope.",
};
const FILING: FilingContext = {
  source: { id: "v-ct", slug: "couplestherapy101", name: "CouplesTherapy101", platforms: ["instagram", "facebook"] },
  crossTargets: [{ id: "v-kb", slug: "kingdom-building-os", name: "Kingdom Building OS", platforms: ["instagram", "facebook"] }],
  cta: { targetSlug: "kingdom-building-os", targetName: "Kingdom Building OS", due: false, publishedCount: 0 },
};

function item(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "item-1",
    ventureId: "v-ct",
    contentType: "meme",
    status: "open",
    threadIndex: 1,
    fileName: "meme.png",
    slackFileId: "F1",
    slackChannelId: "C_CT",
    slackThreadTs: "1727.000001",
    sourceImageUrl: "https://files.slack.com/files-pri/T1-F1/download/meme.png",
    mediaUrl: "https://proj.supabase.co/storage/v1/object/public/content-media/couplestherapy101/item-1/source.png",
    renderUrl: null,
    sourceKind: null,
    sourceCredit: null,
    imgflipTemplateId: null,
    captions: {},
    ...overrides,
  };
}

function file(id: string, name = `${id}.png`, mimetype = "image/png"): SlackFileRef {
  return { id, name, mimetype, urlPrivateDownload: `https://files.slack.com/files-pri/T1-${id}/download/${name}`, size: 120_000 };
}

function textReply(text: string): ModelReply {
  return { content: [{ type: "text", text }], stopReason: "end_turn", inputTokens: 10, outputTokens: 5, latencyMs: 42 };
}

function toolUseReply(name: string, input: Record<string, unknown>, id = "tu_1"): ModelReply {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", inputTokens: 10, outputTokens: 5, latencyMs: 42 };
}

interface Harness {
  agent: ReturnType<typeof createContentAgent>;
  posts: { threadTs: string; text: string; hasBlocks: boolean }[];
  filed: FilingPackage[];
  items: ContentItem[];
  ingested: { fileId: string; status: string; threadIndex: number }[];
  modelQueue: ModelReply[];
  modelCalls: { imageAttached: boolean; card: string }[];
  renders: { templateId: string; texts: string[] }[];
  clock: { now: number };
  ingestError: Error | null;
}

function harness(overrides: Partial<ContentAgentDeps> = {}): Harness {
  const h: Harness = {
    agent: null as unknown as Harness["agent"],
    posts: [],
    filed: [],
    items: [],
    ingested: [],
    modelQueue: [],
    modelCalls: [],
    renders: [],
    clock: { now: 1_000_000 },
    ingestError: null,
  };
  const deps: ContentAgentDeps = {
    ownerId: () => OWNER,
    callModel: async (args) => {
      const last = args.messages.at(-1)!;
      const blocks = Array.isArray(last.content) ? last.content : [];
      const card = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      h.modelCalls.push({ imageAttached: blocks.some((b) => b.type === "image"), card });
      return h.modelQueue.shift() ?? textReply("(default model text)");
    },
    fetchContext: async () => [],
    postReply: async (_channel, threadTs, text, blocks) => {
      h.posts.push({ threadTs, text, hasBlocks: Boolean(blocks) });
      return `ts_${h.posts.length}`;
    },
    updateReply: async () => {},
    loadThreadItems: async (_channel, threadTs) => h.items.filter((i) => i.slackThreadTs === threadTs),
    loadItemByFileId: async (fileId) => h.items.find((i) => i.slackFileId === fileId) ?? null,
    ingestImage: async (args) => {
      if (h.ingestError) throw h.ingestError;
      const created = item({
        id: `item-${args.file.id}`,
        slackFileId: args.file.id,
        fileName: args.file.name,
        slackThreadTs: args.threadTs,
        threadIndex: args.threadIndex,
        status: args.status,
      });
      h.items.push(created);
      h.ingested.push({ fileId: args.file.id, status: args.status, threadIndex: args.threadIndex });
      return created;
    },
    setItemStatus: async (id, status) => {
      h.items = h.items.map((i) => (i.id === id ? { ...i, status } : i));
    },
    loadFilingContext: async () => FILING,
    imgflipAvailable: () => true,
    listTemplates: async () => [{ id: "181913649", name: "Drake Hotline Bling", url: "https://i.imgflip.com/30b1gx.jpg", width: 1, height: 1, boxCount: 2 }],
    renderMeme: async (templateId, texts) => {
      h.renders.push({ templateId, texts });
      return { url: "https://i.imgflip.com/render1.jpg" };
    },
    executeFiling: async (pkg) => {
      h.filed.push(pkg);
      return { proposalId: "prop-1", calendarId: "cal-1", publishMediaUrl: pkg.preview_url, dryRunByVenture: { couplestherapy101: true, "kingdom-building-os": true } };
    },
    now: () => h.clock.now,
    ...overrides,
  };
  h.agent = createContentAgent(deps);
  return h;
}

let tsCounter = 0;
function evt(text: string, opts: { user?: string; threadTs?: string; files?: SlackFileRef[]; ts?: string } = {}): ContentAgentEvent {
  tsCounter += 1;
  return {
    channel: "C_CT",
    user: opts.user ?? OWNER,
    text,
    ts: opts.ts ?? `1727.${String(tsCounter).padStart(6, "0")}`,
    threadTs: opts.threadTs,
    files: opts.files ?? [],
    venture: CT101,
  };
}

const ROOT = "1727.000001";

// --- owner gating -------------------------------------------------------------

test("owner gating: a stranger's file drop gets one read-only line and nothing is ingested; stranger chatter is ignored", async () => {
  const h = harness();
  await h.agent.handleEvent(evt("", { user: "U_OTHER", files: [file("F9")] }));
  assert.equal(h.ingested.length, 0);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0]!.text, /Only Justin can steer/);
  assert.equal(h.modelCalls.length, 0);

  await h.agent.handleEvent(evt("hello?", { user: "U_OTHER" }));
  assert.equal(h.posts.length, 1, "plain chatter from a non-owner outside an agent thread is ignored");
});

test("owner gating: with OWNER_SLACK_USER_ID unset the agent is disabled — fail closed, said out loud", async () => {
  const h = harness({ ownerId: () => undefined });
  await h.agent.handleEvent(evt("", { files: [file("F1")] }));
  assert.equal(h.ingested.length, 0);
  assert.match(h.posts[0]!.text, /OWNER_SLACK_USER_ID is not set/);
});

test("owner gating: a stranger's 'yes' never files a pending package", async () => {
  const h = harness();
  h.items.push(item({ slackThreadTs: ROOT }));
  h.modelQueue.push(toolUseReply("file_for_approval", { source_kind: "repost", caption: "Reading the room.", source_credit: "@templarpilled" }));
  await h.agent.handleEvent(evt("send it", { threadTs: ROOT }));
  assert.equal(h.filed.length, 0);
  assert.match(h.posts.at(-1)!.text, /Ready to file for approval/);

  await h.agent.handleEvent(evt("yes", { user: "U_OTHER", threadTs: ROOT }));
  assert.equal(h.filed.length, 0, "a non-owner affirmative must not execute");
  assert.match(h.posts.at(-1)!.text, /Only Justin can steer/);

  await h.agent.handleEvent(evt("yes", { threadTs: ROOT }));
  assert.equal(h.filed.length, 1, "the owner's yes files it");
});

// --- image drops ---------------------------------------------------------------

test("a single image drop becomes the thread's OPEN item, is shown to the model, and always answers in the drop's thread", async () => {
  const h = harness();
  h.modelQueue.push(textReply("Dramatic scene, deadpan reaction. Format: custom edit. Handle: @templarpilled. Repost or riff?"));
  const drop = evt("", { files: [file("F1")], ts: ROOT });
  await h.agent.handleEvent(drop);

  assert.deepEqual(h.ingested, [{ fileId: "F1", status: "open", threadIndex: 1 }]);
  assert.equal(h.modelCalls.length, 1);
  assert.equal(h.modelCalls[0]!.imageAttached, true, "the mirrored image rides the model call");
  assert.match(h.modelCalls[0]!.card, /Open item: item-F1/);
  assert.match(h.modelCalls[0]!.card, /Publishes to: CouplesTherapy101 → Instagram, Facebook; Kingdom Building OS → Instagram, Facebook/);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0]!.threadTs, ROOT, "the reply is threaded on the drop message — nothing top-level");
});

test("the same Slack file is never two items (dedupe on slack_file_id)", async () => {
  const h = harness();
  h.items.push(item({ slackFileId: "F1", slackThreadTs: ROOT, status: "proposed" }));
  await h.agent.handleEvent(evt("", { files: [file("F1")] }));
  assert.equal(h.ingested.length, 0);
  assert.match(h.posts[0]!.text, /already in play/);
  assert.equal(h.modelCalls.length, 0);
});

test("several images in one drop are numbered and queued; the owner picks by number before any model call", async () => {
  const h = harness();
  h.modelQueue.push(textReply("first read of image 2"));
  await h.agent.handleEvent(evt("", { files: [file("F1", "a.png"), file("F2", "b.png"), file("F3", "c.png")], ts: ROOT }));
  assert.deepEqual(
    h.ingested.map((i) => i.status),
    ["queued", "queued", "queued"],
  );
  assert.match(h.posts[0]!.text, /I see 3 images/);
  assert.match(h.posts[0]!.text, /2\) b\.png/);
  assert.equal(h.modelCalls.length, 0, "no model call until one is picked");

  await h.agent.handleEvent(evt("2 first", { threadTs: ROOT }));
  assert.equal(h.items.find((i) => i.slackFileId === "F2")!.status, "open");
  assert.equal(h.modelCalls.length, 1);
  assert.match(h.modelCalls[0]!.card, /image 2 of 3 \(b\.png\)/);
  assert.match(h.modelCalls[0]!.card, /just picked this image/);

  // A non-number while nothing is open asks again, still without the model.
  h.items = h.items.map((i) => ({ ...i, status: "queued" as const }));
  await h.agent.handleEvent(evt("hmm", { threadTs: ROOT }));
  assert.match(h.posts.at(-1)!.text, /Which image first\? Reply with a number/);
  assert.equal(h.modelCalls.length, 1);
});

test("non-image files are refused; a missing files:read scope is turned into a WHAT JUSTIN DOES line", async () => {
  const h = harness();
  await h.agent.handleEvent(evt("", { files: [file("F1", "notes.pdf", "application/pdf")] }));
  assert.equal(h.ingested.length, 0);
  assert.match(h.posts[0]!.text, /only work from image files/);

  h.ingestError = new SlackFileScopeError("HTTP 403");
  await h.agent.handleEvent(evt("", { files: [file("F2")] }));
  assert.match(h.posts.at(-1)!.text, /files:read/);
  assert.match(h.posts.at(-1)!.text, /WHAT JUSTIN DOES/);
  assert.equal(h.modelCalls.length, 0);
});

test("a link without an image is answered with the screenshot ask — no model call", async () => {
  const h = harness();
  await h.agent.handleEvent(evt("https://www.reddit.com/r/memes/comments/abc/"));
  assert.match(h.posts[0]!.text, /send a screenshot/);
  assert.equal(h.modelCalls.length, 0);
});

// --- confirm-before-file -------------------------------------------------------

test("file_for_approval from the model NEVER files — it becomes a package waiting for the owner's yes; render_meme runs as work", async () => {
  const h = harness();
  h.items.push(item({ slackThreadTs: ROOT }));
  h.modelQueue.push(toolUseReply("render_meme", { template_id: "181913649", texts: ["Reading the room", "Reading Ephesians 5 at the room"] }));
  h.modelQueue.push(textReply("Preview's up — want it?"));
  await h.agent.handleEvent(evt("riff it, drake", { threadTs: ROOT }));
  assert.deepEqual(h.renders, [{ templateId: "181913649", texts: ["Reading the room", "Reading Ephesians 5 at the room"] }]);
  assert.match(h.posts[0]!.text, /Riff preview — Drake Hotline Bling: https:\/\/i\.imgflip\.com\/render1\.jpg/);
  assert.equal(h.posts[0]!.hasBlocks, true, "the preview is posted as an image block in the thread");

  h.modelQueue.push(
    toolUseReply("file_for_approval", {
      source_kind: "riff",
      caption: "Reading the room.",
      imgflip_template_id: "181913649",
      render_url: "https://i.imgflip.com/render1.jpg",
    }),
  );
  await h.agent.handleEvent(evt("ship it", { threadTs: ROOT }));
  assert.equal(h.filed.length, 0, "the model requesting the ACT tool must not file anything");
  const ask = h.posts.at(-1)!;
  assert.match(ask.text, /Ready to file for approval/);
  assert.match(ask.text, /riff on Imgflip template 181913649/);
  assert.match(ask.text, /Kingdom Building OS → Instagram, Facebook/);
  assert.match(ask.text, /10 minutes/);
  assert.equal(ask.hasBlocks, true, "the echo carries the image and both captions as blocks");

  await h.agent.handleEvent(evt("yes", { threadTs: ROOT }));
  assert.equal(h.filed.length, 1);
  const pkg = h.filed[0]!;
  assert.equal(pkg.source_kind, "riff");
  assert.equal(pkg.render_url, "https://i.imgflip.com/render1.jpg");
  assert.deepEqual(pkg.captions, { couplestherapy101: "Reading the room.", "kingdom-building-os": "Reading the room." });
  assert.match(h.posts.at(-1)!.text, /Filed for approval — proposal `prop-1`/);
  assert.match(h.posts.at(-1)!.text, /Dry run for: couplestherapy101, kingdom-building-os/);

  await h.agent.handleEvent(evt("yes", { threadTs: ROOT }));
  assert.equal(h.filed.length, 1, "a confirmation can never file twice");
});

test("an invalid package is refused with the reason and nothing is pending — a repost needs the credit", async () => {
  const h = harness();
  h.items.push(item({ slackThreadTs: ROOT }));
  h.modelQueue.push(toolUseReply("file_for_approval", { source_kind: "repost", caption: "Reading the room." }));
  await h.agent.handleEvent(evt("send it", { threadTs: ROOT }));
  assert.match(h.posts.at(-1)!.text, /can't file that yet/);
  assert.match(h.posts.at(-1)!.text, /creator's handle/);
  h.modelQueue.push(textReply("Nothing is pending."));
  await h.agent.handleEvent(evt("yes", { threadTs: ROOT }));
  assert.equal(h.filed.length, 0, "a yes with nothing pending goes to the model, never files");
});

test("no and expiry: a pending package can be dropped, and an expired one is announced, never filed", async () => {
  const h = harness();
  h.items.push(item({ slackThreadTs: ROOT }));
  const propose = () =>
    h.modelQueue.push(toolUseReply("file_for_approval", { source_kind: "repost", caption: "Reading the room.", source_credit: "templarpilled" }));

  propose();
  await h.agent.handleEvent(evt("send it", { threadTs: ROOT }));
  await h.agent.handleEvent(evt("no", { threadTs: ROOT }));
  assert.match(h.posts.at(-1)!.text, /Dropped — nothing was filed/);
  await h.agent.handleEvent(evt("yes", { threadTs: ROOT }));
  assert.equal(h.filed.length, 0);

  propose();
  await h.agent.handleEvent(evt("send it", { threadTs: ROOT }));
  h.clock.now += PENDING_ACTION_TTL_MS + 1;
  await h.agent.handleEvent(evt("yes", { threadTs: ROOT }));
  assert.equal(h.filed.length, 0);
  assert.match(h.posts.at(-1)!.text, /expired after 10 minutes/);
});

test("a filing failure is reported and nothing claims success", async () => {
  const h = harness({
    executeFiling: async () => {
      throw new Error("content_calendar insert failed: boom");
    },
  });
  h.items.push(item({ slackThreadTs: ROOT }));
  h.modelQueue.push(toolUseReply("file_for_approval", { source_kind: "repost", caption: "Reading the room.", source_credit: "@templarpilled" }));
  await h.agent.handleEvent(evt("send it", { threadTs: ROOT }));
  await h.agent.handleEvent(evt("yes", { threadTs: ROOT }));
  assert.match(h.posts.at(-1)!.text, /Filing failed: content_calendar insert failed: boom/);
  assert.match(h.posts.at(-1)!.text, /Nothing was filed/);
});

// --- pure helpers --------------------------------------------------------------

test("parseImageSelection: numbers and ordinals, not caption text", () => {
  assert.equal(parseImageSelection("2", 3), 2);
  assert.equal(parseImageSelection("#2", 3), 2);
  assert.equal(parseImageSelection("image 3 please", 3), 3);
  assert.equal(parseImageSelection("the second one", 3), 2);
  assert.equal(parseImageSelection("let's do 1 first", 3), 1);
  assert.equal(parseImageSelection("4", 3), null, "out of range");
  assert.equal(parseImageSelection("2 lines would be better", 3), null, "caption feedback is not a selection");
  assert.equal(parseImageSelection("make it punchier", 3), null);
});

test("containsLink catches the usual suspects, including Slack-wrapped urls", () => {
  assert.equal(containsLink("look at this <https://x.com/someone/status/1|x.com>"), true);
  assert.equal(containsLink("saw it on reddit.com/r/memes"), true);
  assert.equal(containsLink("here's a thought about the room"), false);
});

test("describeFiling: the package is code-built — credit appended, CTA required only when due, item must be open", () => {
  const open = item();
  const dueCtx: FilingContext = { ...FILING, cta: { ...FILING.cta!, due: true, publishedCount: 2 } };

  const noCta = describeFiling({ source_kind: "repost", caption: "Reading the room.", source_credit: "@templarpilled" }, open, dueCtx);
  assert.equal(noCta.ok, false);
  assert.match((noCta as { problem: string }).problem, /CTA is due on this post \(2 published so far — this is #3\)/);

  const withCta = describeFiling(
    { source_kind: "repost", caption: "Reading the room.", source_credit: "templarpilled", cta_line: "More of this at @CouplesTherapy101." },
    open,
    dueCtx,
  );
  assert.equal(withCta.ok, true);
  const pkg = (withCta as { act: { input: unknown } }).act.input as FilingPackage;
  assert.deepEqual(pkg.captions, {
    couplestherapy101: "Reading the room.\n\nvia @templarpilled",
    "kingdom-building-os": "Reading the room.\n\nvia @templarpilled\n\nMore of this at @CouplesTherapy101.",
  });
  assert.equal(pkg.preview_url, open.mediaUrl);
  assert.deepEqual(pkg.targets.map((t) => [t.slug, t.platforms]), [
    ["couplestherapy101", ["instagram", "facebook"]],
    ["kingdom-building-os", ["instagram", "facebook"]],
  ]);

  const riffBadUrl = describeFiling({ source_kind: "riff", caption: "x", imgflip_template_id: "1", render_url: "https://evil.example/x.jpg" }, open, FILING);
  assert.equal(riffBadUrl.ok, false);
  assert.match((riffBadUrl as { problem: string }).problem, /i\.imgflip\.com/);

  const already = describeFiling({ source_kind: "repost", caption: "x", source_credit: "@a" }, item({ status: "proposed" }), FILING);
  assert.equal(already.ok, false);
  assert.match((already as { problem: string }).problem, /already proposed/);

  const noStack = describeFiling(
    { source_kind: "repost", caption: "x", source_credit: "@a" },
    open,
    { ...FILING, source: { ...FILING.source, platforms: [] } },
  );
  assert.equal(noStack.ok, false);
  assert.match((noStack as { problem: string }).problem, /sync blotato accounts for couplestherapy101/);
});

test("the context card and model messages carry the image and the CTA state", () => {
  const card = buildContextCard({
    items: [item(), item({ id: "item-2", threadIndex: 2, fileName: "b.png", status: "queued" })],
    active: item(),
    filing: { ...FILING, cta: { ...FILING.cta!, due: true, publishedCount: 5 } },
    imgflipAvailable: false,
    justSelected: false,
  });
  assert.match(card, /Open item: item-1 · image 1 of 2 \(meme\.png\)/);
  assert.match(card, /Other images in this thread: 2\) b\.png — queued/);
  assert.match(card, /Imgflip riffs: NOT configured/);
  assert.match(card, /Kingdom Building OS CTA: DUE on this post \(5 published so far — this would be #6\)/);

  const messages = buildModelMessages(
    [
      { fromBot: true, text: "earlier bot line" },
      { fromBot: false, userId: OWNER, text: "earlier owner line" },
    ],
    { user: OWNER, text: "", files: [file("F1")] },
    { imageUrl: "https://public/meme.png", card },
  );
  assert.equal(messages[0]!.role, "user", "the first message is always a user turn");
  const last = messages.at(-1)!;
  assert.ok(Array.isArray(last.content));
  const blocks = last.content as { type: string }[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "image", "text"],
  );
  assert.match((blocks[0] as unknown as { text: string }).text, /\(dropped an image\)/);
});
