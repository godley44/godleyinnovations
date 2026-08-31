// Block Kit rendering for social-publish outcomes posted to the venture
// channel after an approved social.post goes out via Blotato. One message
// per post, one line per platform — a partial failure must show the
// platforms that DID publish alongside the one that failed, never hide
// them.

import { context, esc, formatUtc, section, type SlackBlock } from "./brief-blocks.js";
import type { SlackMessage } from "./approval-blocks.js";

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X/Twitter",
  linkedin: "LinkedIn",
  youtube: "YouTube",
};

export type PlatformOutcome =
  | { platform: string; status: "published"; publicUrl?: string }
  | { platform: string; status: "submitted" } // accepted by Blotato, result pending
  | { platform: string; status: "dry-run" }
  | { platform: string; status: "failed"; detail: string };

export interface PublishSummaryInput {
  ventureName: string;
  postText: string;
  outcomes: PlatformOutcome[];
  publishedAt: Date;
}

const HEADER_MAX = 150;
const TEXT_PREVIEW_MAX = 280;

// Exported for the approval prompt, which names the platforms a social.post
// will publish to.
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

const label = platformLabel;

function outcomeLine(o: PlatformOutcome): string {
  const name = esc(label(o.platform));
  switch (o.status) {
    case "published":
      return o.publicUrl ? `✅ *${name}* — published (<${o.publicUrl}|view post>)` : `✅ *${name}* — published`;
    case "submitted":
      return `📤 *${name}* — submitted, confirmation pending`;
    case "dry-run":
      return `🧪 *${name}* — dry run (no real key; request logged, nothing sent)`;
    case "failed":
      return `❌ *${name}* — failed: ${esc(o.detail)}`;
  }
}

export function buildPublishSummary(input: PublishSummaryInput): SlackMessage {
  const anyFailed = input.outcomes.some((o) => o.status === "failed");
  const allDryRun = input.outcomes.length > 0 && input.outcomes.every((o) => o.status === "dry-run");
  const headline = allDryRun ? "Publish dry run" : anyFailed ? "Publish issues" : "Published";
  const headerRaw = `${headline} — ${input.ventureName}`;
  const header = headerRaw.length > HEADER_MAX ? `${headerRaw.slice(0, HEADER_MAX - 1)}…` : headerRaw;

  const preview =
    input.postText.length <= TEXT_PREVIEW_MAX
      ? input.postText
      : `${input.postText.slice(0, TEXT_PREVIEW_MAX - 1).trimEnd()}…`;

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: header } },
    section(input.outcomes.map(outcomeLine).join("\n")),
    context(esc(preview)),
    context(`${formatUtc(input.publishedAt)} · Godley Innovations OS`),
  ];
  return { text: headerRaw, blocks };
}
