// The confirm-before-act gate, pinned down in code: ACT tools NEVER execute
// off a model response — only an exact affirmative reply from the owner, in
// the same conversation, against a live pending action. All side effects
// are faked; nothing here talks to Slack, Supabase, or Anthropic.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelReply } from "../integrations/anthropic.js";
import { createManager, type ManagerDeps, type ManagerEvent } from "./manager.js";
import { PENDING_ACTION_TTL_MS, type ProposedAct } from "./pending-actions.js";

const OWNER = "U_OWNER";

function textReply(text: string): ModelReply {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 42,
  };
}

function toolUseReply(name: string, input: Record<string, unknown>, id = "tu_1"): ModelReply {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 42,
  };
}

interface Harness {
  manager: ReturnType<typeof createManager>;
  posts: { threadTs?: string; text: string }[];
  executed: ProposedAct[][];
  reads: string[];
  modelQueue: ModelReply[];
  modelCalls: number;
  clock: { now: number };
}

function harness(overrides: Partial<ManagerDeps> = {}): Harness {
  const h: Harness = {
    manager: null as unknown as Harness["manager"], // assigned below
    posts: [],
    executed: [],
    reads: [],
    modelQueue: [],
    modelCalls: 0,
    clock: { now: 1_000_000 },
  };
  const deps: ManagerDeps = {
    ownerId: () => OWNER,
    callModel: async () => {
      h.modelCalls += 1;
      return h.modelQueue.shift() ?? textReply("(default model text)");
    },
    runReadTool: async (name) => {
      h.reads.push(name);
      return JSON.stringify({ ok: true, tool: name });
    },
    describeAct: async (tool, input) => ({
      ok: true,
      act: { tool, input, summary: `${tool}: ${String(input.proposal_id ?? input.venture_slug ?? "?")}` },
    }),
    executeActs: async (acts) => {
      h.executed.push(acts);
      return acts.map((a) => ({ summary: a.summary, ok: true, skipped: false, detail: "done" }));
    },
    fetchContext: async () => [],
    postReply: async (_channel, threadTs, text) => {
      h.posts.push({ threadTs, text });
      return `ts_${h.posts.length}`;
    },
    updateReply: async () => {},
    now: () => h.clock.now,
    ...overrides,
  };
  h.manager = createManager(deps);
  return h;
}

let tsCounter = 0;
function evt(text: string, opts: { user?: string; threadTs?: string } = {}): ManagerEvent {
  tsCounter += 1;
  return {
    channel: "C_ADMIN",
    user: opts.user ?? OWNER,
    text,
    ts: `1727.${String(tsCounter).padStart(6, "0")}`,
    threadTs: opts.threadTs,
  };
}

const PROPOSAL_ID = "11111111-1111-1111-1111-111111111111";

test("an ACT tool call from the model NEVER executes — it becomes a pending confirmation", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("approve the lil bull brief"));

  assert.equal(h.executed.length, 0, "the model requesting an ACT tool must not execute anything");
  assert.equal(h.posts.length, 1);
  const confirmation = h.posts[0]!.text;
  assert.match(confirmation, /Confirm/, "the reply is a confirmation ask");
  assert.match(confirmation, /approve_proposal: 1{8}/, "it restates exactly what will happen");
  assert.match(confirmation, /yes/i, "it tells the owner how to confirm");
  assert.match(confirmation, /10 minutes/, "it states the TTL");
});

test("an exact affirmative from the owner executes the pending action via executeActs", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("approve it please"));
  await h.manager.handleMessage(evt("yes"));

  assert.equal(h.executed.length, 1, "the confirmed action executes exactly once");
  assert.equal(h.executed[0]![0]!.tool, "approve_proposal");
  assert.equal(h.executed[0]![0]!.input.proposal_id, PROPOSAL_ID);
  const result = h.posts.at(-1)!.text;
  assert.match(result, /✅/, "the outcome is reported");
  // A second "yes" finds nothing pending: nothing executes again.
  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 1, "a confirmation can never execute twice");
});

test('a bare "yes" with nothing pending goes to the model, never to executeActs', async () => {
  const h = harness();
  h.modelQueue.push(textReply("Nothing is pending — want the pending proposals list?"));

  await h.manager.handleMessage(evt("yes"));

  assert.equal(h.executed.length, 0);
  assert.equal(h.modelCalls, 1, "the message goes to the model instead");
});

test("an ambiguous reply does not execute; the pending action stays armed", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("approve it"));
  h.modelQueue.push(textReply("Do you want me to run the pending approval? Reply yes."));
  await h.manager.handleMessage(evt("yes but only if nothing else is pending"));

  assert.equal(h.executed.length, 0, "ambiguity must never execute");

  // The pending action survived the ambiguous reply: a clean yes still runs it.
  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 1);
});

test("owner-id gating: a non-owner's ACT request is refused and nothing goes pending", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("reject_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("reject that proposal", { user: "U_INTRUDER" }));

  assert.equal(h.executed.length, 0);
  assert.match(h.posts[0]!.text, /Only the owner/, "polite refusal");

  // Nothing went pending: the owner's later "yes" has nothing to run.
  h.modelQueue.push(textReply("Nothing is pending."));
  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 0);
});

test("owner-id gating: a non-owner cannot confirm the owner's pending action", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("approve it"));
  await h.manager.handleMessage(evt("yes", { user: "U_INTRUDER" }));

  assert.equal(h.executed.length, 0, "a non-owner yes must not execute");
  assert.match(h.posts.at(-1)!.text, /Only the owner/);

  // The pending action is still live for the owner.
  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 1);
});

test("with OWNER_SLACK_USER_ID unset every ACT is refused — fail closed", async () => {
  const h = harness({ ownerId: () => undefined });
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("approve it"));

  assert.equal(h.executed.length, 0);
  assert.match(h.posts[0]!.text, /OWNER_SLACK_USER_ID/, "the refusal names the missing configuration");
});

test("an expired pending action is announced, not silently dropped — and never executes", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("approve it"));
  h.clock.now += PENDING_ACTION_TTL_MS + 1;
  await h.manager.handleMessage(evt("yes"));

  assert.equal(h.executed.length, 0, "an expired confirmation must never execute");
  assert.match(h.posts.at(-1)!.text, /expired/, "the expiry is announced");
  assert.match(h.posts.at(-1)!.text, /nothing was done/i);
});

test("supersede: a newer ACT proposal replaces the older one, announced; yes runs only the new one", async () => {
  const h = harness();
  const OTHER_ID = "22222222-2222-2222-2222-222222222222";
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));
  await h.manager.handleMessage(evt("approve the brief"));

  h.modelQueue.push(toolUseReply("reject_proposal", { proposal_id: OTHER_ID }));
  await h.manager.handleMessage(evt("actually, reject the framing instead"));

  assert.match(h.posts.at(-1)!.text, /replaces the earlier pending confirmation/i, "supersession is announced");

  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 1);
  assert.equal(h.executed[0]!.length, 1);
  assert.equal(h.executed[0]![0]!.tool, "reject_proposal", "only the NEW action runs");
  assert.equal(h.executed[0]![0]!.input.proposal_id, OTHER_ID);
});

test('a batch ("approve both") confirms as ONE pending action and executes together', async () => {
  const h = harness();
  const OTHER_ID = "22222222-2222-2222-2222-222222222222";
  h.modelQueue.push({
    content: [
      { type: "tool_use", id: "tu_1", name: "approve_proposal", input: { proposal_id: PROPOSAL_ID } },
      { type: "tool_use", id: "tu_2", name: "approve_proposal", input: { proposal_id: OTHER_ID } },
    ],
    stopReason: "tool_use",
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 42,
  });

  await h.manager.handleMessage(evt("approve both"));
  assert.equal(h.executed.length, 0);
  assert.match(h.posts[0]!.text, /Confirm 2 actions/);

  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 1);
  assert.equal(h.executed[0]!.length, 2, "both acts execute under the one confirmation");
});

test('an exact "no" from the owner cancels the pending action', async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));

  await h.manager.handleMessage(evt("approve it"));
  await h.manager.handleMessage(evt("no"));

  assert.equal(h.executed.length, 0);
  assert.match(h.posts.at(-1)!.text, /Cancelled/);

  // Gone for good: a later yes goes to the model, not to execution.
  h.modelQueue.push(textReply("Nothing pending."));
  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 0);
});

test("an invalid ACT (describeAct refuses) arms nothing and reports the problem", async () => {
  const h = harness({
    describeAct: async () => ({ ok: false, problem: "no proposal with id abc" }),
  });
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: "abc" }));

  await h.manager.handleMessage(evt("approve abc"));

  assert.equal(h.executed.length, 0);
  assert.match(h.posts[0]!.text, /no proposal with id abc/);
  assert.match(h.posts[0]!.text, /Nothing is pending/);

  h.modelQueue.push(textReply("Nothing pending."));
  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 0);
});

test("READ tools execute freely in the loop and the final text is posted", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("list_pending_proposals", {}));
  h.modelQueue.push(textReply("You have 2 pending proposals: …"));

  await h.manager.handleMessage(evt("what's pending?"));

  assert.deepEqual(h.reads, ["list_pending_proposals"], "the READ tool ran without any confirmation");
  assert.equal(h.executed.length, 0);
  assert.equal(h.modelCalls, 2, "the tool result went back to the model");
  assert.match(h.posts.at(-1)!.text, /2 pending proposals/);
});

test("a model error is reported in the channel, not swallowed", async () => {
  const h = harness({
    callModel: async () => {
      throw new Error("Anthropic call failed: HTTP 429: rate limited");
    },
  });

  await h.manager.handleMessage(evt("what's pending?"));

  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0]!.text, /error/i);
  assert.match(h.posts[0]!.text, /rate limited/);
});

test("replies stay in the conversation: unthreaded → in-channel, threaded → in-thread", async () => {
  const h = harness();
  h.modelQueue.push(textReply("answer A"));
  await h.manager.handleMessage(evt("hello"));
  assert.equal(h.posts[0]!.threadTs, undefined, "an unthreaded ask gets an in-channel reply (mobile-first)");

  h.modelQueue.push(textReply("answer B"));
  await h.manager.handleMessage(evt("hello again", { threadTs: "1727.000001" }));
  assert.equal(h.posts[1]!.threadTs, "1727.000001", "a threaded ask stays in its thread");
});

test("pending actions are scoped to their conversation: a yes elsewhere does not confirm", async () => {
  const h = harness();
  h.modelQueue.push(toolUseReply("approve_proposal", { proposal_id: PROPOSAL_ID }));
  await h.manager.handleMessage(evt("approve it", { threadTs: "1727.000001" }));

  // "yes" in the main channel (different conversation) — must not execute.
  h.modelQueue.push(textReply("Nothing pending here."));
  await h.manager.handleMessage(evt("yes"));
  assert.equal(h.executed.length, 0);

  // "yes" in the thread that owns the pending action — executes.
  await h.manager.handleMessage(evt("yes", { threadTs: "1727.000001" }));
  assert.equal(h.executed.length, 1);
});
