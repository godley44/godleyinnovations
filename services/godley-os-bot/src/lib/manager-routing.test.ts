// Channel routing: #studio-admin messages go to the manager, venture
// channels keep their existing behavior, and the loop guard holds.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEvent } from "./manager-routing.js";

test("a human message in #studio-admin routes to the manager", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin" }), "manager");
});

test("an @mention in #studio-admin is ignored — its companion message event drives the manager", () => {
  // Both events fire for one @mention message; handling both would reply twice.
  assert.equal(classifyEvent({ type: "app_mention", channelName: "studio-admin" }), "ignore");
});

test("venture channels keep their existing behavior untouched", () => {
  assert.equal(classifyEvent({ type: "app_mention", channelName: "lil-bull" }), "probe");
  assert.equal(classifyEvent({ type: "message", channelName: "lil-bull" }), "ignore");
});

test("an unresolvable channel name falls back to existing behavior", () => {
  assert.equal(classifyEvent({ type: "app_mention", channelName: null }), "probe");
  assert.equal(classifyEvent({ type: "message", channelName: null }), "ignore");
});

test("channel name must be exactly studio-admin", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin-2" }), "ignore");
  assert.equal(classifyEvent({ type: "message", channelName: "my-studio-admin" }), "ignore");
});

test("loop guard: bot-authored messages never route anywhere, even in #studio-admin", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin", botId: "B123" }), "ignore");
  assert.equal(classifyEvent({ type: "app_mention", channelName: "lil-bull", botId: "B123" }), "ignore");
});

test("loop guard: edit/system subtypes never route anywhere", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin", subtype: "message_changed" }), "ignore");
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin", subtype: "channel_join" }), "ignore");
});
