// Block Kit rendering for an approved whatsapp.message proposal delivered to
// the venture channel: a one-line header and the framed text in a code
// block — Slack code blocks give clean select-all-copy on mobile, which is
// the whole point, because the last hop is the owner pasting the text into
// WhatsApp by hand. Nothing here (or anywhere else) sends to WhatsApp.

import { context, esc, formatUtc, type SlackBlock } from "./brief-blocks.js";
import type { SlackMessage } from "./approval-blocks.js";

export interface WhatsAppDeliveryInput {
  framedText: string;
  ventureName: string;
  generatedAt: Date;
}

const HEADER_MAX = 150;

export function buildWhatsAppDelivery(input: WhatsAppDeliveryInput): SlackMessage {
  const headerRaw = `WhatsApp message ready — ${input.ventureName}`;
  const header = headerRaw.length > HEADER_MAX ? `${headerRaw.slice(0, HEADER_MAX - 1)}…` : headerRaw;
  // Backticks inside the text would break the code fence (and WhatsApp has
  // no use for them anyway) — neutralize before fencing, then escape.
  const fenced = esc(input.framedText.replace(/`/g, "'"));
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: header } },
    { type: "section", text: { type: "mrkdwn", text: `\`\`\`\n${fenced}\n\`\`\`` } },
    context("Tap the block, select all, copy — then paste into the WhatsApp group."),
    context(`Generated ${formatUtc(input.generatedAt)} · Godley Innovations OS`),
  ];
  return { text: headerRaw, blocks };
}
