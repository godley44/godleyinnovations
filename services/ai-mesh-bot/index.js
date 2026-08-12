// AI Mesh Bot: routes Slack @mentions to AI persona bridges and relays the
// replies back into the thread. Zero runtime dependencies on purpose — plain
// node:http + node:crypto + global fetch — so it runs anywhere Node 22 runs
// and there is no framework between the safety guards and the reader.
//
// The two safety-critical invariants live in handleTurn() and are enforced
// by scripts/check-mesh-bot.mjs; read the GUARD comments before touching them.

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3000);

// Persona registry. canWriteOS is an access boundary, not a feature flag:
// exactly one persona (claude) may ever write to the Godley Innovations OS.
// The guard script fails the build if a second persona is ever set writable.
const PERSONAS = {
  claude: { webhookEnv: "CLAUDE_WEBHOOK_URL", canWriteOS: true },
  chatgpt: { webhookEnv: "CHATGPT_WEBHOOK_URL", canWriteOS: false },
  gemini: { webhookEnv: "GEMINI_WEBHOOK_URL", canWriteOS: false },
  lindy: { webhookEnv: "LINDY_WEBHOOK_URL", canWriteOS: false },
};
const DEFAULT_PERSONA = "claude";

// Slack retries events it thinks failed; without dedupe a slow bridge means
// the same instruction runs twice. In-memory is acceptable: a restart losing
// the set can at worst double-handle one in-flight event, never loop.
const seenEvents = new Map(); // event_id -> timestamp
const SEEN_TTL_MS = 10 * 60 * 1000;

function alreadySeen(eventId) {
  const now = Date.now();
  for (const [id, ts] of seenEvents) if (now - ts > SEEN_TTL_MS) seenEvents.delete(id);
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

// --- Slack request verification -------------------------------------------

function verifySlackSignature(rawBody, headers) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false; // refuse everything rather than run unverified
  const ts = headers["x-slack-request-timestamp"];
  const given = headers["x-slack-signature"];
  if (!ts || !given) return false;
  // Reject old timestamps: replaying a captured request must not work.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const expected =
    "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Text handling ---------------------------------------------------------

// Strip <@U123> mentions and Slack link markup; the bridges get clean prose.
function cleanText(text) {
  return (text ?? "")
    .replace(/<@[^>]+>/g, " ")
    .replace(/<(https?:[^>|]+)(\|[^>]*)?>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// The first word after the mention picks the persona; anything else routes
// to the default. Deliberately forgiving — a typo'd persona name becomes a
// question for claude, not a dropped message.
function parsePersona(cleaned) {
  const first = cleaned.split(" ")[0]?.toLowerCase().replace(/[,:]$/, "");
  if (first && Object.hasOwn(PERSONAS, first)) {
    return { persona: first, instruction: cleaned.slice(first.length).trim() };
  }
  return { persona: DEFAULT_PERSONA, instruction: cleaned };
}

// --- Slack API helpers ------------------------------------------------------

async function slackApi(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
  return data;
}

async function postToThread(channel, threadTs, text) {
  await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text });
}

// Prior thread messages, oldest first, without the triggering message —
// bridges get conversation context instead of re-asking the user.
async function fetchThreadContext(channel, threadTs, triggerTs) {
  if (!threadTs) return [];
  try {
    const data = await slackApi("conversations.replies", {
      channel,
      ts: threadTs,
      limit: 15,
    });
    return (data.messages ?? [])
      .filter((m) => m.ts !== triggerTs)
      .map((m) => ({ user: m.user ?? m.bot_id ?? "unknown", text: cleanText(m.text) }));
  } catch {
    return []; // context is best-effort; a missing history must not block a reply
  }
}

// --- Bridges and the OS ------------------------------------------------------

async function callBridge(persona, body) {
  const url = process.env[PERSONAS[persona].webhookEnv];
  if (!url) return { reply: null, osUpdate: null, unconfigured: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`bridge returned ${res.status}`);
    const data = await res.json();
    return { reply: data.reply ?? null, osUpdate: data.osUpdate ?? null };
  } finally {
    clearTimeout(timer);
  }
}

async function writeToOS(osUpdate) {
  const url = process.env.GODLEY_OS_WEBHOOK_URL;
  const secret = process.env.OS_WEBHOOK_SECRET;
  if (!url || !secret) throw new Error("OS webhook not configured");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(osUpdate),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`OS webhook rejected the update: ${data.error ?? res.status}`);
  }
  return data;
}

// --- The turn ---------------------------------------------------------------

async function handleTurn(event) {
  // GUARD:mention-only — we subscribe only to app_mention, but the check is
  // repeated here so a future extra event subscription (message.channels,
  // say) cannot silently widen what triggers the bot. Mention-only is the
  // loop-breaker: bots replying to bots is how infinite AI threads start.
  if (event.type !== "app_mention") return;

  // GUARD:no-bot-echo — never react to messages authored by any bot
  // (including ourselves) or to message edits/system subtypes. Same
  // loop-breaker as above, second layer.
  if (event.bot_id || event.subtype) return;

  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  const { persona, instruction } = parsePersona(cleanText(event.text));

  if (!instruction) {
    await postToThread(channel, threadTs, `What should ${persona} do? Add an instruction after the mention.`);
    return;
  }

  const context = await fetchThreadContext(channel, event.thread_ts, event.ts);

  let bridge;
  try {
    bridge = await callBridge(persona, {
      instruction,
      context,
      channel,
      threadTs,
      raw: event,
    });
  } catch (err) {
    await postToThread(channel, threadTs, `${persona} bridge failed: ${err.message}`);
    return;
  }

  if (bridge.unconfigured) {
    await postToThread(
      channel,
      threadTs,
      `The ${persona} persona isn't wired up yet (no ${PERSONAS[persona].webhookEnv} set).`,
    );
    return;
  }

  if (bridge.reply) await postToThread(channel, threadTs, bridge.reply);

  // GUARD:os-write-claude-only — the access boundary. Every persona's bridge
  // may return an osUpdate, but only claude's is honored. This is enforced
  // here, at the single call site of writeToOS, rather than trusting each
  // bridge to behave: bridges are the least-trusted part of this system.
  if (bridge.osUpdate) {
    if (persona === "claude" && PERSONAS[persona].canWriteOS) {
      try {
        const result = await writeToOS(bridge.osUpdate);
        // OS writes land as pending proposals (migration 002); say so in the
        // thread so the human knows there's a decision waiting on their phone.
        await postToThread(channel, threadTs, `📥 ${result.note ?? "Proposal filed — approve it in the OS app."}`);
      } catch (err) {
        await postToThread(channel, threadTs, `Reply posted, but the OS update failed: ${err.message}`);
      }
    }
    // Non-claude osUpdate: dropped on purpose, silently. Telling the channel
    // "gemini tried to write to the OS" would just teach people to ask it to.
  }
}

// --- HTTP server --------------------------------------------------------------

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/slack/events") {
    res.writeHead(req.url === "/healthz" ? 200 : 404).end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (!verifySlackSignature(raw, req.headers)) {
      res.writeHead(401).end();
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }

    // Slack's one-time endpoint handshake.
    if (body.type === "url_verification") {
      res.writeHead(200, { "content-type": "text/plain" }).end(body.challenge);
      return;
    }

    // Ack immediately (Slack retries after 3s), then process. Retries that
    // do arrive are dropped by the event-id dedupe.
    res.writeHead(200).end();
    if (body.type === "event_callback" && !alreadySeen(body.event_id)) {
      handleTurn(body.event).catch((err) =>
        console.error("handleTurn failed:", err.message),
      );
    }
  });
});

server.listen(PORT, () => console.log(`ai-mesh-bot listening on :${PORT}`));
