// The pending_action lifecycle: create → confirm → execute (take), expire,
// supersede. The clock is injected so expiry is tested without real waits.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PENDING_ACTION_TTL_MS, PendingActionStore, type ProposedAct } from "./pending-actions.js";

const act = (summary: string): ProposedAct => ({
  tool: "approve_proposal",
  input: { proposal_id: "00000000-0000-0000-0000-000000000001" },
  summary,
});

function storeWithClock(startMs = 1_000_000): { store: PendingActionStore; tick: (ms: number) => void } {
  let now = startMs;
  return {
    store: new PendingActionStore(() => now),
    tick: (ms) => {
      now += ms;
    },
  };
}

test("create → peek pending → take claims it exactly once", () => {
  const { store } = storeWithClock();
  store.propose("C1:channel", [act("Approve X")]);

  const peeked = store.peek("C1:channel");
  assert.equal(peeked.state, "pending");

  const taken = store.take("C1:channel");
  assert.ok(taken, "a live pending action must be claimable");
  assert.equal(taken.acts[0]!.summary, "Approve X");

  // The claim is destructive: the same confirmation can never execute twice.
  assert.equal(store.take("C1:channel"), null);
  assert.equal(store.peek("C1:channel").state, "none");
});

test("expiry: past the TTL the action is reported expired ONCE, then gone", () => {
  const { store, tick } = storeWithClock();
  store.propose("C1:channel", [act("Approve X")]);

  tick(PENDING_ACTION_TTL_MS - 1);
  assert.equal(store.peek("C1:channel").state, "pending", "one ms before the TTL it is still live");

  tick(1);
  const expired = store.peek("C1:channel");
  assert.equal(expired.state, "expired", "at the TTL it must be reported expired — never silently dropped");
  assert.equal(expired.state === "expired" && expired.action.acts[0]!.summary, "Approve X");

  // Announced once; afterwards it is simply gone.
  assert.equal(store.peek("C1:channel").state, "none");
});

test("take never hands out an expired action", () => {
  const { store, tick } = storeWithClock();
  store.propose("C1:channel", [act("Approve X")]);
  tick(PENDING_ACTION_TTL_MS + 1);
  assert.equal(store.take("C1:channel"), null, "an expired confirmation must not execute");
});

test("supersede: a new proposal replaces the old one and returns it for announcement", () => {
  const { store } = storeWithClock();
  store.propose("C1:channel", [act("Approve X")]);
  const { superseded } = store.propose("C1:channel", [act("Reject Y")]);

  assert.ok(superseded, "the replaced action must be returned so it can be announced");
  assert.equal(superseded.acts[0]!.summary, "Approve X");

  const taken = store.take("C1:channel");
  assert.equal(taken?.acts[0]!.summary, "Reject Y", "only the NEW action is executable");
});

test("superseding an already-expired action does not report it as replaced", () => {
  const { store, tick } = storeWithClock();
  store.propose("C1:channel", [act("Approve X")]);
  tick(PENDING_ACTION_TTL_MS + 1);
  const { superseded } = store.propose("C1:channel", [act("Reject Y")]);
  assert.equal(superseded, null, "an expired action was never live to supersede");
});

test("cancel removes a live action; conversations are isolated by key", () => {
  const { store } = storeWithClock();
  store.propose("C1:channel", [act("Approve X")]);
  store.propose("C1:1727000000.000100", [act("Approve thread-thing")]);

  const cancelled = store.cancel("C1:channel");
  assert.equal(cancelled?.acts[0]!.summary, "Approve X");
  assert.equal(store.peek("C1:channel").state, "none");
  // The thread's pending action is untouched.
  assert.equal(store.peek("C1:1727000000.000100").state, "pending");
});

test("count reports live entries and sweeps expired ones", () => {
  const { store, tick } = storeWithClock();
  store.propose("a", [act("A")]);
  store.propose("b", [act("B")]);
  assert.equal(store.count(), 2);
  tick(PENDING_ACTION_TTL_MS + 1);
  assert.equal(store.count(), 0);
});
