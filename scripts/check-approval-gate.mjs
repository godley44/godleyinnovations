// Guard script: the approval gate is the ONLY path to publishing, sending, or
// changing state on an external platform. Every automated write files a
// proposal; apply_proposal() (the owner tapping Approve — in the app or the
// Slack buttons) is what executes it. That invariant is runtime behavior no
// compiler checks, so this script pins it textually and fails any PR that
// adds a way around it. Runs as the `approval-gate` CI job and in
// `npm run check`.
//
// Grep-based and therefore blunt by design: a legitimate refactor that trips
// a rule updates the rule IN THE SAME COMMIT and says why in the commit
// message. The rules:
//
//   1. deploy-on-main only ever runs for pushes to main (no pull_request
//      trigger), and no other workflow applies migrations or deploys
//      functions — migrations never run on PR branches.
//   2. Raw outbound HTTP (`fetch(`) in the bot is confined to an allowlist of
//      integration files. A new file talking to the internet must be listed
//      here, which forces the question "does this go through the gate?".
//   3. The Blotato publish primitives (publishPost / getPostStatus) are called
//      from exactly one place: the poller's publish step, which only picks
//      content_calendar rows in status approved/publishing — and 'approved' is
//      set by apply_proposal() alone.
//   4. Nobody flips a proposal to 'approved' except the database function:
//      no `status: "approved"` literal in any TS/TSX; `.rpc(` is only ever
//      `apply_proposal`, and only from the two human decision paths (the app's
//      ApprovalsCard and the Slack interactions route); `.update(` on
//      `proposals` only in those two files (reject is a decision too).
//   5. Edge functions never write OS tables directly: the only mutation is an
//      `.insert(` into `proposals` (os-ingest); no `.rpc(` at all.
//   6. In SQL, every `status = 'approved'` lives inside an apply_proposal()
//      body; no other function, trigger, or ad-hoc statement approves.
//   7. No code talks to end-user delivery platforms directly (Meta/WhatsApp
//      Graph, Twilio, X, LinkedIn, YouTube, mail APIs) — publishing goes
//      through the Blotato client, and WhatsApp is always pasted by hand.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (msg) => failures.push(msg);

const BOT_SRC = "services/godley-os-bot/src";
const APP_SRC = "src";
const FUNCTIONS = "supabase/functions";

function walk(dir, exts) {
  const abs = join(root, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") out.push(...walk(join(dir, name), exts));
    } else if (exts.some((e) => name.endsWith(e))) {
      out.push(relative(root, p).split("\\").join("/"));
    }
  }
  return out;
}
const read = (rel) => readFileSync(join(root, rel), "utf8");
const isTest = (rel) => /\.test\.tsx?$/.test(rel);
// Rules look at code, not prose: comment lines (`//`, `#`, `--`) and the
// insides of /* */ blocks are dropped before matching, so documentation that
// NAMES a forbidden thing doesn't trip the rule that forbids it.
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|#|--)/.test(line))
    .join("\n");
const readCode = (rel) => code(read(rel));

// --- 1. main-only deploys ----------------------------------------------------
const DEPLOY_WORKFLOW = ".github/workflows/deploy-on-main.yml";
{
  let wf = "";
  try {
    wf = read(DEPLOY_WORKFLOW);
  } catch {
    fail(`${DEPLOY_WORKFLOW} is missing`);
  }
  if (wf) {
    if (!/^on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/m.test(wf)) {
      fail(`${DEPLOY_WORKFLOW} must trigger on \`push: branches: [main]\` and nothing broader`);
    }
    if (/^\s+pull_request/m.test(wf)) {
      fail(`${DEPLOY_WORKFLOW} must not run on pull_request — migrations never run for PR branches`);
    }
  }
  for (const rel of walk(".github/workflows", [".yml", ".yaml"])) {
    if (rel === DEPLOY_WORKFLOW) continue;
    const text = readCode(rel);
    if (/supabase\s+(db\s+push|functions\s+deploy|migration\s+repair)/.test(text)) {
      fail(`${rel} runs a production deploy command — only ${DEPLOY_WORKFLOW} may`);
    }
  }
}

// --- 2. raw HTTP allowlist (bot) ---------------------------------------------
const FETCH_ALLOWLIST = new Set([
  `${BOT_SRC}/integrations/blotato.ts`, // publishing — gated by rule 3
  `${BOT_SRC}/integrations/openai.ts`, // framing — output becomes a NEW pending proposal
  `${BOT_SRC}/lib/slack-web.ts`, // Slack is the workroom, not an external platform
  `${BOT_SRC}/routes/slack-interactions.ts`, // response_url acknowledgement of a decision
]);
for (const rel of walk(BOT_SRC, [".ts"])) {
  if (isTest(rel)) continue;
  if (/\bfetch\s*\(/.test(readCode(rel)) && !FETCH_ALLOWLIST.has(rel)) {
    fail(`${rel} calls fetch() but is not in the raw-HTTP allowlist (check-approval-gate.mjs rule 2)`);
  }
}

// --- 3. one publish call site, fed only by approved rows -------------------
{
  const POLLER = `${BOT_SRC}/lib/report-poller.ts`;
  for (const fn of ["publishPost", "getPostStatus"]) {
    const sites = [];
    for (const rel of walk(BOT_SRC, [".ts"])) {
      if (isTest(rel) || rel === `${BOT_SRC}/integrations/blotato.ts`) continue;
      const n = (readCode(rel).match(new RegExp(`\\b${fn}\\(`, "g")) ?? []).length;
      if (n > 0) sites.push(`${rel} (${n})`);
    }
    if (sites.length !== 1 || !sites[0].startsWith(`${POLLER} (1)`)) {
      fail(`${fn}() must be called exactly once, from ${POLLER}; found: ${sites.join(", ") || "none"}`);
    }
  }
  let poller = "";
  try {
    poller = readCode(POLLER);
  } catch {
    fail(`${POLLER} is missing`);
  }
  if (poller && !/\.from\("content_calendar"\)[\s\S]{0,200}\.in\("status", \["approved", "publishing"\]\)/.test(poller)) {
    fail(`${POLLER} must select publish work with .from("content_calendar")….in("status", ["approved", "publishing"])`);
  }
}

// --- 4. approval happens only in apply_proposal ------------------------------
const DECISION_FILES = new Set([`${APP_SRC}/components/ApprovalsCard.tsx`, `${BOT_SRC}/routes/slack-interactions.ts`]);
for (const rel of [...walk(APP_SRC, [".ts", ".tsx"]), ...walk(BOT_SRC, [".ts"]), ...walk(FUNCTIONS, [".ts"])]) {
  if (isTest(rel)) continue;
  const text = readCode(rel);
  if (/status:\s*["']approved["']/.test(text)) {
    fail(`${rel} writes status: "approved" — only apply_proposal() may approve`);
  }
  for (const m of text.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)) {
    if (m[1] !== "apply_proposal") fail(`${rel} calls rpc("${m[1]}") — the only allowed rpc is apply_proposal`);
    if (!DECISION_FILES.has(rel)) fail(`${rel} calls apply_proposal — only the human decision paths may (${[...DECISION_FILES].join(", ")})`);
  }
  for (const m of text.matchAll(/\.from\(\s*["']proposals["']\s*\)([\s\S]{0,300})/g)) {
    const chain = m[1].split(/\n\s*\n/)[0];
    if (/\.(update|upsert|delete)\(/.test(chain) && !DECISION_FILES.has(rel)) {
      fail(`${rel} mutates proposals outside the decision paths — file a new proposal instead`);
    }
  }
}

// --- 5. edge functions only file proposals -----------------------------------
for (const rel of walk(FUNCTIONS, [".ts"])) {
  if (isTest(rel)) continue;
  const text = readCode(rel);
  if (/\.rpc\(/.test(text)) fail(`${rel} calls .rpc() — edge functions may only insert proposals`);
  for (const m of text.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)([\s\S]{0,300})/g)) {
    const [, table, rest] = m;
    const chain = rest.split(/\n\s*\n/)[0];
    const mutation = chain.match(/\.(insert|update|upsert|delete)\(/)?.[1];
    if (mutation && !(table === "proposals" && mutation === "insert")) {
      fail(`${rel} does .from("${table}").${mutation}() — edge functions may only .insert() into proposals`);
    }
  }
}

// --- 6. SQL: 'approved' is written only inside apply_proposal() ------------
for (const rel of walk("supabase/migrations", [".sql"])) {
  const text = read(rel);
  const bodies = [...text.matchAll(/create or replace function public\.apply_proposal[\s\S]*?\$\$([\s\S]*?)\$\$;/g)].map((m) =>
    [m.index, m.index + m[0].length],
  );
  for (const m of text.matchAll(/status\s*=\s*'approved'/g)) {
    const inside = bodies.some(([a, b]) => m.index >= a && m.index < b);
    if (!inside) {
      const line = text.slice(0, m.index).split("\n").length;
      fail(`${rel}:${line} sets status = 'approved' outside apply_proposal()`);
    }
  }
}

// --- 7. no direct end-user delivery platforms --------------------------------
const FORBIDDEN_HOSTS =
  /graph\.facebook\.com|api\.whatsapp\.com|twilio\.com|api\.twitter\.com|api\.x\.com|api\.linkedin\.com|googleapis\.com|sendgrid|mailgun|resend\.com|postmarkapp/i;
for (const rel of [...walk(BOT_SRC, [".ts"]), ...walk(FUNCTIONS, [".ts"])]) {
  if (isTest(rel)) continue;
  const hit = readCode(rel).match(FORBIDDEN_HOSTS);
  if (hit) fail(`${rel} references ${hit[0]} — direct delivery to end-user platforms bypasses the gate (publish via Blotato; WhatsApp is pasted by hand)`);
}

if (failures.length > 0) {
  console.error("check-approval-gate FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("check-approval-gate OK: every external write still goes through apply_proposal / the decision paths.");
