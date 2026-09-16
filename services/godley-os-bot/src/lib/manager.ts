// The AI Manager — the conversational operator living in #studio-admin.
// Flow per human message (the events route already acked Slack; everything
// here is post-200 background work):
//
//   1. If this conversation has a PENDING ACTION and the reply is an exact
//      affirmative → execute it (owner only), via the same code paths the
//      buttons use. Exact negative → cancel. Anything else → the model, and
//      the pending action stays armed until it expires or is superseded.
//   2. Otherwise: model turn — recent conversation context + tools, loop on
//      READ tool calls, and when the model calls an ACT tool, DO NOT
//      EXECUTE: validate, park as a pending action, and ask the owner to
//      confirm with a code-built restatement of exactly what will happen.
//
// The confirmation gate is enforced HERE, in code: executeActs is reachable
// only from the affirmative-reply branch after PendingActionStore.take()
// returns a live entry — never from a model response. The unit tests pin
// this down.
//
// Reply convention (chosen for mobile): an unthreaded owner message gets an
// IN-CHANNEL reply — #studio-admin is a dedicated 1:1 office, and a flat
// scroll keeps the ask → confirm → result exchange visible in one glance,
// where thread replies hide behind a "1 reply" tap and their notifications
// are easy to lose on a phone. If the owner starts a thread, the manager
// stays in it.

import type { AnthropicTool, ChatMessage, ContentBlock, ModelReply, ToolResultBlock, ToolUseBlock } from "../integrations/anthropic.js";
import { callClaude } from "../integrations/anthropic.js";
import { classifyReply } from "./affirmative.js";
import { describeAct, executeActs, type ActOutcome } from "./manager-acts.js";
import { MANAGER_SYSTEM_PROMPT } from "./manager-prompt.js";
import { recordManagerError, recordManagerMessage, recordModelCall, setPendingActionCount } from "./manager-state.js";
import { isActTool, MANAGER_TOOLS, runReadTool } from "./manager-tools.js";
import { PendingActionStore, type ActToolName, type PendingAction, type ProposedAct } from "./pending-actions.js";
import { fetchRecentMessages, postMessage, updateMessage } from "./slack-web.js";

const CONTEXT_LIMIT = 15;
const MAX_MODEL_CALLS = 6;
const PLACEHOLDER_AFTER_MS = 5_000;
const THINKING_TEXT = "🤔 Working on it…";

export interface ManagerEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
}

export interface ContextMessage {
  fromBot: boolean;
  userId?: string;
  text: string;
}

// Every side effect is injected so the gating logic is unit-testable with
// fakes — the live wiring at the bottom of this file supplies the real ones.
export interface ManagerDeps {
  ownerId(): string | undefined;
  callModel(args: { system: string; messages: ChatMessage[]; tools: AnthropicTool[] }): Promise<ModelReply>;
  runReadTool(name: string, input: Record<string, unknown>): Promise<string>;
  describeAct(
    tool: ActToolName,
    input: Record<string, unknown>,
  ): Promise<{ ok: true; act: ProposedAct } | { ok: false; problem: string }>;
  executeActs(acts: ProposedAct[]): Promise<ActOutcome[]>;
  fetchContext(channel: string, threadTs: string | undefined, excludeTs: string, limit: number): Promise<ContextMessage[]>;
  postReply(channel: string, threadTs: string | undefined, text: string): Promise<string>;
  updateReply(channel: string, ts: string, text: string): Promise<void>;
  now(): number;
}

function conversationKey(event: ManagerEvent): string {
  return `${event.channel}:${event.threadTs ?? "channel"}`;
}

function summariesOf(action: PendingAction): string {
  return action.acts.map((a) => `• ${a.summary}`).join("\n");
}

function renderConfirmation(acts: ProposedAct[], superseded: PendingAction | null): string {
  const lines =
    acts.length === 1
      ? `⚠️ *Confirm:* ${acts[0]!.summary}`
      : `⚠️ *Confirm ${acts.length} actions:*\n${acts.map((a, i) => `${i + 1}. ${a.summary}`).join("\n")}`;
  const supersedeNote = superseded
    ? `\n_(This replaces the earlier pending confirmation — that one is off the table:\n${summariesOf(superseded)})_`
    : "";
  return `${lines}\nReply *yes* to run it or *no* to cancel — this expires in 10 minutes.${supersedeNote}`;
}

function renderOutcomes(outcomes: ActOutcome[]): string {
  return outcomes
    .map((o) => {
      if (o.ok) return `✅ ${o.summary}\n→ ${o.detail}`;
      if (o.skipped) return `⏭️ ${o.summary}\n→ ${o.detail}`;
      return `❌ ${o.summary}\n→ FAILED: ${o.detail}`;
    })
    .join("\n");
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function buildModelMessages(context: ContextMessage[], event: ManagerEvent): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const m of context) {
    const text = m.text.trim();
    if (!text) continue;
    if (m.fromBot) messages.push({ role: "assistant", content: text });
    else messages.push({ role: "user", content: `${m.userId ? `<@${m.userId}>: ` : ""}${text}` });
  }
  messages.push({ role: "user", content: `<@${event.user}>: ${event.text}`.trim() });
  // The API requires the first message to be a user turn.
  while (messages.length > 0 && messages[0]!.role === "assistant") messages.shift();
  return messages;
}

export function createManager(deps: ManagerDeps) {
  const store = new PendingActionStore(deps.now);

  async function executeConfirmed(event: ManagerEvent, action: PendingAction): Promise<void> {
    const outcomes = await deps.executeActs(action.acts);
    await deps.postReply(event.channel, event.threadTs, renderOutcomes(outcomes));
  }

  // The ONLY place a model ACT request goes: validate → park → ask. Never
  // executes anything.
  async function proposeActs(key: string, isOwner: boolean, toolUses: ToolUseBlock[]): Promise<string> {
    if (!isOwner) {
      const configured = deps.ownerId() !== undefined;
      return configured
        ? "🔒 Only the owner can approve, reject, or file drafts here — I can answer read-only questions for you. Nothing was changed."
        : "🔒 OWNER_SLACK_USER_ID is not set, so all actions are disabled (fail closed). Set it in the Render environment, then ask again. Nothing was changed.";
    }
    const described = await Promise.all(toolUses.map((t) => deps.describeAct(t.name as ActToolName, t.input)));
    const problems = described.filter((d): d is { ok: false; problem: string } => !d.ok);
    if (problems.length > 0) {
      // Never confirm a half-valid batch — report and arm nothing.
      return `⚠️ I can't set that up:\n${problems.map((p) => `• ${p.problem}`).join("\n")}\nNothing is pending.`;
    }
    const acts = described.map((d) => (d as { ok: true; act: ProposedAct }).act);
    const { superseded } = store.propose(key, acts);
    setPendingActionCount(store.count());
    return renderConfirmation(acts, superseded);
  }

  async function modelTurn(event: ManagerEvent, key: string, isOwner: boolean): Promise<void> {
    // "Thinking" placeholder only if the model is slow (~5s), edited into
    // the final reply via chat.update so the channel never keeps both.
    const placeholder: { ts: string | null; promise: Promise<void> | null } = { ts: null, promise: null };
    const timer = setTimeout(() => {
      placeholder.promise = deps
        .postReply(event.channel, event.threadTs, THINKING_TEXT)
        .then((ts) => {
          placeholder.ts = ts;
        })
        .catch((err) => console.error("[manager] placeholder post failed:", err));
    }, PLACEHOLDER_AFTER_MS);

    const deliver = async (text: string): Promise<void> => {
      clearTimeout(timer);
      if (placeholder.promise) await placeholder.promise;
      if (placeholder.ts) {
        try {
          await deps.updateReply(event.channel, placeholder.ts, text);
          return;
        } catch (err) {
          console.error("[manager] chat.update of the placeholder failed, posting fresh:", err);
        }
      }
      await deps.postReply(event.channel, event.threadTs, text);
    };

    try {
      const context = await deps.fetchContext(event.channel, event.threadTs, event.ts, CONTEXT_LIMIT);
      const messages = buildModelMessages(context, event);

      for (let call = 0; call < MAX_MODEL_CALLS; call++) {
        const reply = await deps.callModel({ system: MANAGER_SYSTEM_PROMPT, messages, tools: MANAGER_TOOLS });
        recordModelCall(reply.latencyMs);

        const toolUses = reply.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        const actUses = toolUses.filter((t) => isActTool(t.name));

        if (actUses.length > 0) {
          // Confirm-before-act: the model turn ends here, unexecuted.
          await deliver(await proposeActs(key, isOwner, actUses));
          return;
        }

        if (reply.stopReason === "tool_use" && toolUses.length > 0) {
          messages.push({ role: "assistant", content: reply.content });
          const results: ToolResultBlock[] = await Promise.all(
            toolUses.map(async (t): Promise<ToolResultBlock> => {
              try {
                return { type: "tool_result", tool_use_id: t.id, content: await deps.runReadTool(t.name, t.input) };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { type: "tool_result", tool_use_id: t.id, content: `Error: ${message}`, is_error: true };
              }
            }),
          );
          messages.push({ role: "user", content: results });
          continue;
        }

        await deliver(textOf(reply.content) || "(The model returned an empty reply — try rephrasing.)");
        return;
      }
      await deliver(`⚠️ I stopped after ${MAX_MODEL_CALLS} tool rounds without a final answer — try a narrower question.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordManagerError(message);
      console.error(`[manager] turn failed: ${message}`);
      await deliver(`⚠️ The manager hit an error: ${message}`);
    }
  }

  async function handleMessage(event: ManagerEvent): Promise<void> {
    recordManagerMessage();
    const key = conversationKey(event);
    const ownerId = deps.ownerId();
    const isOwner = ownerId !== undefined && event.user === ownerId;
    const intent = classifyReply(event.text);
    const lookup = store.peek(key);
    setPendingActionCount(store.count());

    if (lookup.state === "expired") {
      // Announced, never silently dropped.
      await deps.postReply(
        event.channel,
        event.threadTs,
        `⌛ The pending confirmation expired after 10 minutes — nothing was done:\n${summariesOf(lookup.action)}\nAsk again if you still want it.`,
      );
      // A bare yes/no was aimed at the expired action; anything else is a
      // fresh request and still deserves a real answer.
      if (intent !== "other") return;
    }

    if (lookup.state === "pending") {
      if (intent === "affirmative") {
        if (!isOwner) {
          await deps.postReply(
            event.channel,
            event.threadTs,
            "🔒 Only the owner can confirm actions — this confirmation stays pending for them. Nothing was changed.",
          );
          return;
        }
        const action = store.take(key);
        setPendingActionCount(store.count());
        if (!action) return; // raced with expiry — peek already announced next time
        await executeConfirmed(event, action);
        return;
      }
      if (intent === "negative" && isOwner) {
        store.cancel(key);
        setPendingActionCount(store.count());
        await deps.postReply(
          event.channel,
          event.threadTs,
          `🚫 Cancelled — nothing was done:\n${summariesOf(lookup.action)}`,
        );
        return;
      }
      // Anything ambiguous: fall through to the model (it can re-ask); the
      // pending action stays armed until TTL or supersession.
    }

    await modelTurn(event, key, isOwner);
  }

  return { handleMessage };
}

// --- Live wiring ------------------------------------------------------------

function liveDeps(): ManagerDeps {
  return {
    ownerId: () => {
      const id = process.env.OWNER_SLACK_USER_ID?.trim();
      return id ? id : undefined;
    },
    callModel: (args) => callClaude(args),
    runReadTool,
    describeAct,
    executeActs,
    fetchContext: async (channel, threadTs, excludeTs, limit) => {
      const history = await fetchRecentMessages({ channel, threadTs, limit: limit + 5 });
      return history
        .filter(
          (m) =>
            m.ts !== excludeTs &&
            m.text.trim() !== "" &&
            // Keep real messages only; "bot_message" is how Slack sometimes
            // subtypes app posts (the manager's own replies belong in
            // context), every other subtype is an edit/join/system record.
            (!m.subtype || m.subtype === "bot_message"),
        )
        .slice(-limit)
        .map((m) => ({
          fromBot: m.botId !== undefined || m.subtype === "bot_message",
          userId: m.userId,
          text: m.text,
        }));
    },
    postReply: (channel, threadTs, text) => postMessage({ channel, threadTs, text }),
    updateReply: (channel, ts, text) => updateMessage({ channel, ts, text }),
    now: Date.now,
  };
}

let liveManager: ReturnType<typeof createManager> | null = null;

export async function handleManagerMessage(event: ManagerEvent): Promise<void> {
  liveManager ??= createManager(liveDeps());
  await liveManager.handleMessage(event);
}
