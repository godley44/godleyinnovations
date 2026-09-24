// Block Kit rendering for the Slack approval loop: a PENDING proposal is
// posted to the venture's channel with Approve/Reject buttons, and after a
// decision the message is re-rendered to say what was decided.
//
// The buttons are wired to the EXISTING interactions contract defined in
// src/routes/slack-interactions.ts — action_id "approve" / "reject", the
// proposal id in the button's value — this module renders to that contract,
// it does not redefine it.
//
// buildDecidedMessage is shared by the two paths that retire a prompt:
//  - the interactions route, replacing the message via response_url right
//    after a button tap (via: "by Justin");
//  - the poller's disarm step, chat.update-ing a prompt whose proposal was
//    decided somewhere else (no via — the bot can't know where), so the
//    buttons never stay live for an already-decided proposal.

import { context, esc, formatUtc, image, section, type SlackBlock } from "./brief-blocks.js";
import { platformLabel } from "./social-blocks.js";

// Keep the preview phone-sized; the full payload lives in the OS.
const PREVIEW_MAX = 600;
// Compact field rendering for non-note payloads: short values, few fields —
// never a raw JSON wall.
const FIELD_VALUE_MAX = 120;
const FIELDS_MAX = 8;

export interface PendingProposal {
  proposalId: string;
  ventureName: string;
  action: string;
  proposedBy: string;
  createdAt: Date;
  payload: Record<string, unknown>;
}

export interface SlackMessage {
  text: string; // notification fallback
  blocks: SlackBlock[];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatCents(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  const sign = raw < 0 ? "-" : "+";
  const abs = Math.abs(raw);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function fieldLine(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return `*${esc(label)}:* ${esc(truncate(rendered, FIELD_VALUE_MAX))}`;
}

// whatsapp.message previews show the WHOLE framed text (in a code block, so
// the preview is exactly what gets pasted) — approving a message you can
// only half-see would defeat the human gate. The cap exists only as a Slack
// hard-limit guard; framed messages are ~1200 chars by construction.
const WHATSAPP_PREVIEW_MAX = 1500;

// Social posts are short by nature (a tweet caps at 280); the guard exists
// only for Slack's hard block limit, same as the WhatsApp cap.
const SOCIAL_PREVIEW_MAX = 1500;

function fence(text: string): string {
  return `\`\`\`\n${esc(truncate(text, SOCIAL_PREVIEW_MAX).replace(/`/g, "'"))}\n\`\`\``;
}

function firstMediaUrl(payload: Record<string, unknown>): string | null {
  const urls = Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [];
  const first = urls.find((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  return first ?? null;
}

// The content agent's payload extras: targets [{ slug, name, platforms }]
// and captions { slug: text }. Absent on Lil Bull's text posts.
export function socialTargets(payload: Record<string, unknown>): { slug: string; name: string; platforms: string[] }[] {
  if (!Array.isArray(payload.targets)) return [];
  return payload.targets.flatMap((raw) => {
    const t = raw as Record<string, unknown>;
    if (typeof t.slug !== "string" || typeof t.name !== "string") return [];
    const platforms = Array.isArray(t.platforms) ? t.platforms.filter((p): p is string => typeof p === "string") : [];
    return [{ slug: t.slug, name: t.name, platforms }];
  });
}

export function socialCaptions(payload: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof payload.captions === "object" && payload.captions !== null && !Array.isArray(payload.captions)) {
    for (const [slug, text] of Object.entries(payload.captions as Record<string, unknown>)) {
      if (typeof text === "string" && text.trim()) out.set(slug, text);
    }
  }
  return out;
}

// Where an approval prompt should be posted: a content item's proposal
// carries the Slack thread the conversation lives in, so its buttons land
// there instead of at the top of the channel. Only honored when the thread
// is in the venture's own channel (the payload is data, the channel is the
// resolved venture channel).
export function promptThread(payload: Record<string, unknown>, ventureChannelId: string): string | undefined {
  const channel = payload.slack_channel_id;
  const threadTs = payload.slack_thread_ts;
  if (typeof channel !== "string" || typeof threadTs !== "string") return undefined;
  return channel === ventureChannelId && /^\d+\.\d+$/.test(threadTs) ? threadTs : undefined;
}

// Per-action payload previews. Field names mirror the os-ingest contract
// (supabase/functions/os-ingest); anything unrecognized falls back to
// compact field lines so a new action shows up readably instead of as JSON.
function previewBlocks(action: string, payload: Record<string, unknown>): SlackBlock[] {
  if (action === "note.append" && typeof payload.text === "string" && payload.text.trim()) {
    return [
      section(esc(truncate(payload.text, PREVIEW_MAX))),
      context("Full text lands in the OS after approval."),
    ];
  }
  if (action === "whatsapp.message" && typeof payload.text === "string" && payload.text.trim()) {
    const full = payload.text.length <= WHATSAPP_PREVIEW_MAX;
    const fenced = esc(truncate(payload.text, WHATSAPP_PREVIEW_MAX).replace(/`/g, "'"));
    return [
      section(`\`\`\`\n${fenced}\n\`\`\``),
      context(
        full
          ? "This exact text is what gets handed over for WhatsApp after approval."
          : "Preview truncated — the full text gets handed over for WhatsApp after approval.",
      ),
    ];
  }
  if (action === "social.post" && typeof payload.text === "string" && payload.text.trim()) {
    // The exact post body in a code block plus WHERE it goes — approval is
    // the only path to publishing, so the owner must see both. A content
    // item (image post, migration 008) adds the image itself, every target
    // venture's caption, and the full target list.
    const platforms = Array.isArray(payload.platforms)
      ? payload.platforms.filter((p): p is string => typeof p === "string").map(platformLabel)
      : [];
    const targets = socialTargets(payload);
    const blocks: SlackBlock[] = [];
    const mediaUrl = firstMediaUrl(payload);
    if (mediaUrl) blocks.push(image(mediaUrl, "post image"));
    const captions = socialCaptions(payload);
    if (targets.length > 0 && captions.size > 0) {
      for (const t of targets) {
        const caption = captions.get(t.slug) ?? payload.text;
        const where = t.platforms.length > 0 ? t.platforms.map(platformLabel).join(", ") : "⚠️ no platform configured";
        blocks.push(section(`*${esc(t.name)}* → ${esc(where)}\n${fence(caption)}`));
      }
    } else {
      blocks.push(section(fence(payload.text)));
    }
    const destinations =
      targets.length > 0
        ? targets.map((t) => `${t.name} (${t.platforms.map(platformLabel).join(", ") || "none"})`).join("; ")
        : platforms.length > 0
          ? platforms.join(", ")
          : "the venture's platform stack";
    const credit = typeof payload.credit === "string" && payload.credit ? ` Credit: ${payload.credit}.` : "";
    blocks.push(
      context(
        `${payload.text.length <= SOCIAL_PREVIEW_MAX ? "This exact text" : "Preview truncated — the full text"} publishes to ` +
          `${esc(destinations)} via Blotato after approval. Nothing publishes without it.${esc(credit)}`,
      ),
    );
    return blocks;
  }
  if (action === "ledger.add") {
    const amount = formatCents(payload.amount_cents);
    const lines = [
      amount ? `*Amount:* ${amount}` : "*Amount:* ⚠️ missing or not integer cents",
      fieldLine("Category", payload.category),
      fieldLine("Date", payload.occurred_on),
      fieldLine("Counterparty", payload.counterparty),
      fieldLine("Item", payload.item),
      fieldLine("Note", payload.note),
    ].filter((l): l is string => l !== null);
    return [section(lines.join("\n"))];
  }
  if (action === "ticket.add") {
    const lines = [
      fieldLine("Subject", payload.subject) ?? "*Subject:* ⚠️ missing",
      fieldLine("Customer", payload.customer),
      fieldLine("Channel", payload.channel),
      fieldLine("Opened", payload.opened_on),
    ].filter((l): l is string => l !== null);
    return [section(lines.join("\n"))];
  }
  // Unknown action, or a known action with an unusable payload.
  const entries = Object.entries(payload)
    .map(([key, value]) => fieldLine(key, value))
    .filter((l): l is string => l !== null);
  if (entries.length === 0) return [section("⚠️ Empty or unreadable payload — reject unless you know why.")];
  const shown = entries.slice(0, FIELDS_MAX);
  if (entries.length > FIELDS_MAX) shown.push(`…and ${entries.length - FIELDS_MAX} more field(s)`);
  return [section(shown.join("\n"))];
}

const HEADER_MAX = 150;

export function buildApprovalPrompt(proposal: PendingProposal): SlackMessage {
  const header = truncate(`Approval needed — ${proposal.ventureName}`, HEADER_MAX);
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: header } },
    section(
      `*${esc(proposal.action)}* proposed by *${esc(proposal.proposedBy)}* · ${formatUtc(proposal.createdAt)}`,
    ),
    ...previewBlocks(proposal.action, proposal.payload),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "approve",
          value: proposal.proposalId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "reject",
          value: proposal.proposalId,
        },
      ],
    },
  ];
  return {
    text: `Approval needed — ${proposal.ventureName}: ${proposal.action} from ${proposal.proposedBy}`,
    blocks,
  };
}

export interface DecisionContext {
  decision: "approve" | "reject";
  ventureName: string;
  action: string;
  proposedBy: string;
  decidedAt: Date;
  via?: string; // e.g. "by Justin" — omitted when the bot can't know who/where
}

export function buildDecidedMessage(ctx: DecisionContext): SlackMessage {
  const mark = ctx.decision === "approve" ? "✅" : "❌";
  const verb = ctx.decision === "approve" ? "Approved" : "Rejected";
  const via = ctx.via ? ` ${esc(ctx.via)}` : "";
  const when = formatUtc(ctx.decidedAt);
  return {
    text: `${mark} ${verb} — ${ctx.ventureName}: ${ctx.action} (${when})`,
    blocks: [
      section(`${mark} *${verb}${via}* · ${when}`),
      context(`${esc(ctx.ventureName)} · ${esc(ctx.action)} · proposed by ${esc(ctx.proposedBy)}`),
    ],
  };
}
