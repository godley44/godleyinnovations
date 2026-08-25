// Block Kit rendering for OS reports posted to Slack, starting with the
// Lil Bull Weekly Market Brief.
//
// The input is the exact text the owner approved (proposals.payload.text,
// assembled deterministically by supabase/functions/weekly-insight):
// blank-line-separated sections whose labels are stable ("Timeframes:",
// "This week:", "Sentiment:", "Week lean:", "Legend — ", the disclaimer,
// stance lines like "S&P 500: Bullish - key level ..."). Sections are matched by
// label, not position, and any section this module doesn't recognize is
// passed through as its own block — a new section added to the brief shows
// up in Slack instead of silently disappearing.
//
// Slack hard limits enforced here: 150 chars of header text, 3000 chars of
// mrkdwn per section (long sections split on line boundaries), 50 blocks per
// message.

export interface SlackButton {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value: string;
  style?: "primary" | "danger";
}

export type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] }
  | { type: "actions"; elements: SlackButton[] }
  | { type: "divider" };

export interface BriefMessageInput {
  briefText: string;
  ventureName: string;
  generatedAt: Date;
}

export interface BriefMessage {
  text: string; // notification fallback
  blocks: SlackBlock[];
}

const HEADER_MAX = 150;
const SECTION_MAX = 2900; // headroom under Slack's 3000-char mrkdwn limit
const BLOCKS_MAX = 50;

// Slack mrkdwn requires exactly these three entities escaped, everywhere —
// code blocks included.
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

// Split mrkdwn into ≤SECTION_MAX section blocks, preferring line boundaries.
function sectionChunks(text: string): SlackBlock[] {
  if (text.length <= SECTION_MAX) return [section(text)];
  const blocks: SlackBlock[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > SECTION_MAX && current) {
      blocks.push(section(current));
      current = line;
    } else if (candidate.length > SECTION_MAX) {
      // A single line longer than the limit: hard cut.
      for (let i = 0; i < line.length; i += SECTION_MAX) {
        blocks.push(section(line.slice(i, i + SECTION_MAX)));
      }
      current = "";
    } else {
      current = candidate;
    }
  }
  if (current) blocks.push(section(current));
  return blocks;
}

const STANCE_LINE = /^\S[^\n]*?:\s+(Bullish|Bearish|Neutral)\b/;

function isStanceSection(raw: string): boolean {
  const lines = raw.split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => STANCE_LINE.test(l));
}

// One brief section (already escaped) → its Slack blocks.
function renderSection(raw: string): SlackBlock[] {
  if (raw.startsWith("Timeframes:")) {
    const table = raw.slice("Timeframes:".length).replace(/^\n/, "");
    return sectionChunks(`*Timeframes*\n\`\`\`\n${table}\n\`\`\``);
  }
  if (raw.startsWith("This week:")) {
    const items = raw
      .slice("This week:".length)
      .replace(/^\n/, "")
      .split("\n")
      .map((line) => line.replace(/^- /, "• "))
      .join("\n");
    return sectionChunks(`*This week*\n${items}`);
  }
  if (raw.startsWith("Sentiment:")) {
    return sectionChunks(`*Sentiment:*${raw.slice("Sentiment:".length)}`);
  }
  if (raw.startsWith("Week lean:")) {
    return sectionChunks(`*Week lean:*${raw.slice("Week lean:".length)}`);
  }
  if (raw.startsWith("Legend — ") || /not financial advice/i.test(raw)) {
    return [context(raw)];
  }
  if (isStanceSection(raw)) {
    const lines = raw
      .split("\n")
      .map((line) => line.replace(/^([^:\n]+):/, "*$1:*"))
      .join("\n");
    return sectionChunks(`*Stances*\n${lines}`);
  }
  if (/data unavailable/i.test(raw)) {
    return sectionChunks(`⚠️ ${raw}`);
  }
  return sectionChunks(raw);
}

export function buildBriefMessage(input: BriefMessageInput): BriefMessage {
  const sections = input.briefText
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // The brief always leads with its title line. If the first section carries
  // more lines than the title, the remainder stays in the body.
  const firstLines = (sections[0] ?? "Report").split("\n");
  const title = firstLines[0] ?? "Report";
  const body = [...sections.slice(1)];
  if (firstLines.length > 1) body.unshift(firstLines.slice(1).join("\n"));

  const headerText = title.length > HEADER_MAX ? `${title.slice(0, HEADER_MAX - 1)}…` : title;

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: headerText } },
    context(`*${esc(input.ventureName)}*`),
  ];
  for (const raw of body) {
    blocks.push(...renderSection(esc(raw)));
  }
  blocks.push({ type: "divider" });
  const footer = context(`Generated ${formatUtc(input.generatedAt)} · Godley Innovations OS`);

  // 50-block cap: keep the front of the report and the footer, say so.
  if (blocks.length + 1 > BLOCKS_MAX) {
    blocks.length = BLOCKS_MAX - 2;
    blocks.push(context("(truncated — full text in the OS app)"));
  }
  blocks.push(footer);

  return { text: `${title} — ${input.ventureName}`, blocks };
}
