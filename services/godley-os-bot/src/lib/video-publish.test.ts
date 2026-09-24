// The video half of publishing: Blotato requests for YouTube and Instagram
// video posts, the video social.post proposal shape, and the approval
// previews the owner sees (script first, then the video with its preview
// link).

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPublishRequest } from "../integrations/blotato.js";
import { buildApprovalPrompt } from "./approval-blocks.js";
import { socialProposalRow } from "./social-draft.js";

const VIDEO_URL = "https://ref.supabase.co/storage/v1/object/public/media/video/j/video.mp4";

test("youtube video request: title, privacy from the venture, notify only when public, synthetic-media disclosure on", () => {
  const req = buildPublishRequest({
    platform: "youtube",
    accountId: "acc",
    text: "caption",
    mediaUrls: [VIDEO_URL],
    youtube: { title: "Weekly brief", privacyStatus: "public", shouldNotifySubscribers: true },
  });
  assert.deepEqual(req, {
    post: {
      accountId: "acc",
      content: { text: "caption", mediaUrls: [VIDEO_URL], platform: "youtube" },
      target: {
        targetType: "youtube",
        title: "Weekly brief",
        privacyStatus: "public",
        shouldNotifySubscribers: true,
        containsSyntheticMedia: true,
      },
    },
  });
});

test("youtube refuses a post without media or without a title", () => {
  assert.throws(
    () => buildPublishRequest({ platform: "youtube", accountId: "a", text: "t", mediaUrls: [], youtube: { title: "x", privacyStatus: "public", shouldNotifySubscribers: false } }),
    /video mediaUrl is required/,
  );
  assert.throws(() => buildPublishRequest({ platform: "youtube", accountId: "a", text: "t", mediaUrls: [VIDEO_URL] }), /title and privacy/);
});

test("instagram video request: a reel; refuses text-only", () => {
  const req = buildPublishRequest({ platform: "instagram", accountId: "acc", text: "caption", mediaUrls: [VIDEO_URL] });
  assert.deepEqual(req.post.target, { targetType: "instagram", mediaType: "reel" });
  assert.equal(req.post.content.platform, "instagram");
  assert.throws(() => buildPublishRequest({ platform: "instagram", accountId: "a", text: "t", mediaUrls: [] }), /video mediaUrl is required/);
});

test("video social.post proposal: filed by the video agent with kind, title and the preview link; text posts unchanged", () => {
  const video = socialProposalRow({
    ventureId: "v",
    calendarId: "c",
    text: "script",
    platforms: ["youtube"],
    proposedBy: "video-agent",
    video: { title: "Weekly brief", previewUrl: VIDEO_URL },
  });
  assert.deepEqual(video, {
    venture_id: "v",
    action: "social.post",
    proposed_by: "video-agent",
    payload: { calendar_id: "c", text: "script", platforms: ["youtube"], kind: "video", title: "Weekly brief", preview_url: VIDEO_URL },
  });
  const text = socialProposalRow({ ventureId: "v", calendarId: "c", text: "post", platforms: ["twitter"] });
  assert.deepEqual(text.payload, { calendar_id: "c", text: "post", platforms: ["twitter"] });
  assert.equal(text.proposed_by, "admin");
});

function blockTexts(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

test("video.script approval prompt shows the whole script, the title, the platforms, and warns that approval spends minutes", () => {
  const msg = buildApprovalPrompt({
    proposalId: "p",
    ventureName: "Lil Bull",
    action: "video.script",
    proposedBy: "video-agent",
    createdAt: new Date("2026-09-24T00:00:00Z"),
    payload: { script: "Here is the takeaway. Follow Lil Bull.", title: "Weekly brief", platforms: ["youtube"], cta: "Follow Lil Bull." },
  });
  const text = blockTexts(msg.blocks);
  assert.match(text, /Weekly brief/);
  assert.match(text, /7 words/);
  assert.match(text, /YouTube/);
  assert.match(text, /Here is the takeaway\. Follow Lil Bull\./);
  assert.match(text, /spends ElevenLabs and Pictory minutes/);
  assert.match(text, /nothing publishes until then/);
  assert.ok(msg.blocks.some((b) => (b as { type: string }).type === "actions"), "same Approve/Reject buttons contract");
});

test("video social.post approval prompt leads with the preview link and the title", () => {
  const msg = buildApprovalPrompt({
    proposalId: "p",
    ventureName: "Lil Bull",
    action: "social.post",
    proposedBy: "video-agent",
    createdAt: new Date("2026-09-24T00:00:00Z"),
    payload: { calendar_id: "c", text: "caption", platforms: ["youtube", "instagram"], kind: "video", title: "Weekly brief", preview_url: VIDEO_URL },
  });
  const text = blockTexts(msg.blocks);
  assert.match(text, /Watch the video/);
  assert.ok(text.includes(VIDEO_URL));
  assert.match(text, /Weekly brief/);
  assert.match(text, /YouTube, Instagram/);
  assert.match(text, /video above publish/);
});

test("a video social.post without a preview link says so instead of hiding it", () => {
  const msg = buildApprovalPrompt({
    proposalId: "p",
    ventureName: "Lil Bull",
    action: "social.post",
    proposedBy: "video-agent",
    createdAt: new Date(),
    payload: { calendar_id: "c", text: "caption", platforms: ["youtube"], kind: "video", title: "t" },
  });
  assert.match(blockTexts(msg.blocks), /No preview link/);
});
