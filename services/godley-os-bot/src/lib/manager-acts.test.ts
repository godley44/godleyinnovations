// resolvePendingReference: the model sometimes passes a made-up handle
// instead of a proposal uuid. The resolver maps it onto the REAL pending
// list; only an unambiguous match resolves, everything else is a problem
// that names the actual candidates. It must never pick among several.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePendingReference, type PendingRef } from "./manager-acts.js";

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const ROW_A: PendingRef = { id: UUID_A, venture: "Lil Bull", action: "social.post" };
const ROW_B: PendingRef = { id: UUID_B, venture: "Lil Bull", action: "whatsapp.brief" };

test("a real uuid passes through untouched, even with nothing pending", () => {
  const r = resolvePendingReference(UUID_A, []);
  assert.deepEqual(r, { ok: true, id: UUID_A });
});

test("a placeholder resolves to the single pending proposal", () => {
  const r = resolvePendingReference("pending-lil-bull-note", [ROW_A]);
  assert.deepEqual(r, { ok: true, id: UUID_A });
});

test("a placeholder with nothing pending is a clear problem", () => {
  const r = resolvePendingReference("pending-lil-bull-note", []);
  assert.equal(r.ok, false);
  assert.match((r as { problem: string }).problem, /no proposal is pending/);
});

test("a unique uuid prefix resolves among several pending", () => {
  const r = resolvePendingReference(UUID_A.slice(0, 8), [ROW_A, ROW_B]);
  assert.deepEqual(r, { ok: true, id: UUID_A });
});

test("prefix matching ignores case", () => {
  const r = resolvePendingReference(UUID_B.slice(0, 8).toUpperCase(), [ROW_A, ROW_B]);
  assert.deepEqual(r, { ok: true, id: UUID_B });
});

test("an ambiguous placeholder with several pending lists the candidates instead of guessing", () => {
  const r = resolvePendingReference("pending-lil-bull-note", [ROW_A, ROW_B]);
  assert.equal(r.ok, false);
  const problem = (r as { problem: string }).problem;
  assert.match(problem, /2 proposals are pending/);
  assert.ok(problem.includes(UUID_A));
  assert.ok(problem.includes(UUID_B));
  assert.match(problem, /Lil Bull · social\.post/);
});

test("an empty reference with several pending never matches by prefix", () => {
  const r = resolvePendingReference("", [ROW_A, ROW_B]);
  assert.equal(r.ok, false);
  assert.match((r as { problem: string }).problem, /"\(empty\)" is not a proposal id/);
});
