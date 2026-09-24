// Channel routing: #studio-admin messages go to the manager, high-touch
// venture channels go to the content agent (file drops included), hands-off
// venture channels keep their existing behavior, and the loop guard holds.

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

test("hands-off venture channels keep their existing behavior untouched", () => {
  assert.equal(classifyEvent({ type: "app_mention", channelName: "lil-bull", ventureMode: "hands_off" }), "probe");
  assert.equal(classifyEvent({ type: "message", channelName: "lil-bull", ventureMode: "hands_off" }), "ignore");
  // A file dropped in a hands-off channel is logged only, like any message there.
  assert.equal(
    classifyEvent({ type: "message", channelName: "lil-bull", ventureMode: "hands_off", subtype: "file_share" }),
    "ignore",
  );
});

test("high-touch venture channels route human messages AND file drops to the content agent", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "couplestherapy101", ventureMode: "high_touch" }), "venture-agent");
  assert.equal(
    classifyEvent({ type: "message", channelName: "couplestherapy101", ventureMode: "high_touch", subtype: "file_share" }),
    "venture-agent",
  );
  // The app_mention twin of an @mention message is dropped, same as #studio-admin.
  assert.equal(classifyEvent({ type: "app_mention", channelName: "couplestherapy101", ventureMode: "high_touch" }), "ignore");
});

test("a channel that is not a venture (or whose lookup failed) falls back to existing behavior", () => {
  assert.equal(classifyEvent({ type: "app_mention", channelName: null }), "probe");
  assert.equal(classifyEvent({ type: "message", channelName: null }), "ignore");
  assert.equal(classifyEvent({ type: "app_mention", channelName: "general", ventureMode: null }), "probe");
  assert.equal(classifyEvent({ type: "message", channelName: "general", ventureMode: null, subtype: "file_share" }), "ignore");
});

test("channel name must be exactly studio-admin", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin-2" }), "ignore");
  assert.equal(classifyEvent({ type: "message", channelName: "my-studio-admin" }), "ignore");
});

test("a file dropped in #studio-admin is not a manager conversation", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin", subtype: "file_share" }), "ignore");
});

test("loop guard: bot-authored messages never route anywhere, even in #studio-admin or a high-touch channel", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin", botId: "B123" }), "ignore");
  assert.equal(classifyEvent({ type: "app_mention", channelName: "lil-bull", botId: "B123" }), "ignore");
  assert.equal(
    classifyEvent({ type: "message", channelName: "couplestherapy101", ventureMode: "high_touch", botId: "B123", subtype: "file_share" }),
    "ignore",
  );
});

test("loop guard: edit/system subtypes never route anywhere — file_share is the only subtype that does", () => {
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin", subtype: "message_changed" }), "ignore");
  assert.equal(classifyEvent({ type: "message", channelName: "studio-admin", subtype: "channel_join" }), "ignore");
  assert.equal(
    classifyEvent({ type: "message", channelName: "couplestherapy101", ventureMode: "high_touch", subtype: "message_changed" }),
    "ignore",
  );
  assert.equal(
    classifyEvent({ type: "message", channelName: "couplestherapy101", ventureMode: "high_touch", subtype: "thread_broadcast" }),
    "ignore",
  );
});
