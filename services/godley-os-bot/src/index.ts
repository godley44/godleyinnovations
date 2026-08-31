// godley-os-bot: Slack bot backend for the Godley Innovations OS.
// Hono app — the routes:
//   GET  /health                 → 200 "ok" (Render health check)
//   POST /slack/events           → Events API (signature-verified);
//                                  @mentions answer with the health probe
//   POST /slack/interactions     → interactivity: Approve/Reject buttons
//                                  (signature-verified)
//   POST /admin/deliver-now      → run one poll cycle now
//   POST /admin/social-draft     → file a social post for approval
//   GET  /admin/blotato-accounts → list Blotato accounts (real key only)
//                                  (all /admin: ADMIN_SECRET bearer auth)
// Plus the poller (src/lib/report-poller.ts) on a 60s interval.

import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { startReportPoller } from "./lib/report-poller.js";
import { adminRoutes } from "./routes/admin.js";
import { slackEvents } from "./routes/slack-events.js";
import { slackInteractions } from "./routes/slack-interactions.js";

// Local development only: load .env when it exists (cp .env.example .env —
// see README). On Render there is no .env file and the dashboard-injected
// environment is used as-is. Safe to run after the imports above because
// every module reads process.env lazily, never at import time.
if (existsSync(".env")) process.loadEnvFile(".env");

const app = new Hono();

app.get("/health", (c) => c.text("ok", 200));
app.route("/slack/events", slackEvents);
app.route("/slack/interactions", slackInteractions);
app.route("/admin", adminRoutes);

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`godley-os-bot listening on :${info.port}`);
  startReportPoller();
});
