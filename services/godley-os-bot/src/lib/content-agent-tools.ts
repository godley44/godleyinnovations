// The venture content agent's tool surface. Same split as the AI Manager's
// (src/lib/manager-tools.ts):
//
//  WORK tools — executed immediately: list_meme_templates reads the Imgflip
//  catalog; render_meme renders a preview with Imgflip and posts it in the
//  thread. A render is a preview for the owner's eyes, not a publish.
//
//  The ACT tool — file_for_approval — is a DEFINITION ONLY here: when the
//  model calls it, src/lib/content-agent.ts parks it as a pending action and
//  asks the owner to confirm; execution (after "yes") files the content
//  calendar row + social.post proposal through src/lib/content-agent-acts.ts,
//  which reuses fileSocialDraft. Nothing here publishes — approval does.

import type { AnthropicTool } from "../integrations/anthropic.js";

export const CONTENT_ACT_TOOL = "file_for_approval" as const;

// Instagram's own caption cap; Facebook allows far more, so this is the
// binding limit for a cross-published caption.
export const CAPTION_MAX_CHARS = 2200;

export const CONTENT_AGENT_TOOLS: AnthropicTool[] = [
  {
    name: "list_meme_templates",
    description:
      "The Imgflip meme templates available for a riff: id, name, and how many text boxes each has. " +
      "Pass a query to filter by name; without one you get the most popular templates.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Optional name filter, e.g. "drake" or "buttons".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: "render_meme",
    description:
      "Render a riff with Imgflip: the template id plus one text per text box, in order. The preview is " +
      "posted in this thread automatically and the result carries its url — use that exact url as " +
      "render_url when you later file the riff. Rendering publishes nothing.",
    input_schema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "An id from list_meme_templates." },
        texts: {
          type: "array",
          items: { type: "string" },
          description: "One string per text box, top to bottom (box_count from the template).",
        },
      },
      required: ["template_id", "texts"],
      additionalProperties: false,
    },
  },
  // --- ACT tool: definition only; see the module header -------------------
  {
    name: CONTENT_ACT_TOOL,
    description:
      "File the current image for approval as a social post (the content calendar row and its social.post " +
      "proposal). Call it ONLY after the owner said send / approve / queue / ship it. The system will echo " +
      "the final package and ask him to confirm; nothing is filed until he says yes, and nothing publishes " +
      "until he approves the proposal. Never claim it was filed after calling this.",
    input_schema: {
      type: "object",
      properties: {
        source_kind: { type: "string", enum: ["repost", "riff"], description: "repost = the dropped image as-is; riff = the Imgflip render." },
        caption: {
          type: "string",
          description: 'The final caption for the source venture (1–2 lines). For a repost it ends with the credit; the system appends "via @handle" if you forgot.',
        },
        source_credit: {
          type: "string",
          description: 'The creator handle exactly as visible, e.g. "@templarpilled". REQUIRED for a repost; optional for a riff.',
        },
        imgflip_template_id: { type: "string", description: "Riff only: the template id that was rendered." },
        render_url: { type: "string", description: "Riff only: the image url returned by the render_meme call the owner approved." },
        cta_line: {
          type: "string",
          description:
            "Only when the thread context says a CTA is due for the cross-publish venture: one fresh one-line invitation to check out @CouplesTherapy101.",
        },
      },
      required: ["source_kind", "caption"],
      additionalProperties: false,
    },
  },
];

export function isContentActTool(name: string): boolean {
  return name === CONTENT_ACT_TOOL;
}
