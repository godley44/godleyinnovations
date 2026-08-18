// godley-os-bot: Slack bot backend for the Godley Innovations OS.
// Hono app — three routes, nothing else:
//   GET  /health              → 200 "ok" (Render health check)
//   POST /slack/events        → Events API (signature-verified)
//   POST /slack/interactions  → interactivity: Approve/Reject buttons
//                               (signature-verified)

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { slackEvents } from "./routes/slack-events.js";
import { slackInteractions } from "./routes/slack-interactions.js";

const app = new Hono();

app.get("/health", (c) => c.text("ok", 200));
app.route("/slack/events", slackEvents);
app.route("/slack/interactions", slackInteractions);

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`godley-os-bot listening on :${info.port}`);
});
