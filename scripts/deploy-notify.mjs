// Deploy summary for #studio-admin, called by the last step of
// .github/workflows/deploy-on-main.yml (which runs `if: always()`, so this
// sees failures too). Reads the step outcomes from the environment, writes
// one line, and POSTs it to the bot's ADMIN_SECRET-protected /admin/notify
// route, which posts it to #studio-admin.
//
// Two deliberate behaviors:
//   - BOT_URL / BOT_ADMIN_SECRET unset → the deploy itself is unaffected; the
//     step prints a warning and exits 0. Posting needs those two values (from
//     the Doppler vault: BOT_URL and ADMIN_SECRET — see docs/secrets.md) and
//     adding them is the owner's job, not a reason to fail a deploy.
//   - Both set but the POST fails → exit 1, so a deploy whose summary never
//     reached the owner shows red instead of silently looking fine.
//
// The secret is only ever sent as the Authorization header — never printed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function botVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "services", "godley-os-bot", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function commitSubject() {
  try {
    return execFileSync("git", ["log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function list(value) {
  return (value ?? "").split(/\s+/).filter(Boolean);
}

const steps = [
  ["vault", env.OUTCOME_VAULT],
  ["secrets", env.OUTCOME_SECRETS],
  ["change detection", env.OUTCOME_CHANGES],
  ["CLI install", env.OUTCOME_CLI],
  ["migration baseline", env.OUTCOME_BASELINE],
  ["migrations", env.OUTCOME_MIGRATE],
  ["function secrets", env.OUTCOME_FN_SECRETS],
  ["edge functions", env.OUTCOME_FUNCTIONS],
];
const failedStep = steps.find(([, outcome]) => outcome === "failure")?.[0] ?? null;
const ok = env.JOB_STATUS === "success" && failedStep === null;

const sha = (env.COMMIT_SHA ?? "").slice(0, 7);
const subject = commitSubject();
const merged = subject ? `${subject} (${sha})` : sha || "unknown commit";
const applied = list(env.APPLIED_MIGRATIONS);
const added = list(env.ADDED_MIGRATIONS);
const functions = list(env.FUNCTIONS_PLANNED);
const version = botVersion();
const botNote = env.BOT_CHANGED === "true" ? `bot v${version} (Render is redeploying it)` : `bot v${version} (unchanged)`;

// Where this run's secrets came from — the owner's end-to-end check that the
// vault path works: "secrets: Doppler" with nothing still from GitHub means
// the legacy GitHub secrets are unused. Names only, never values.
const fallback = list(env.SECRETS_FALLBACK);
const secretsNote =
  env.SECRETS_SOURCE === "doppler"
    ? fallback.length > 0
      ? `secrets: Doppler (still from GitHub: ${fallback.join(", ")})`
      : "secrets: Doppler"
    : "secrets: GitHub (DOPPLER_TOKEN not set)";
const fnSynced = list(env.FUNCTION_SECRETS_SYNCED);
const fnMissing = list(env.FUNCTION_SECRETS_MISSING);
const fnSecretsNote =
  env.SECRETS_SOURCE !== "doppler"
    ? null
    : fnSynced.length > 0
      ? `function secrets from the vault: ${fnSynced.join(", ")}${fnMissing.length > 0 ? ` (not in the vault yet: ${fnMissing.join(", ")})` : ""}`
      : "function secrets: none in the vault yet";

let text;
if (ok) {
  const migrationsNote =
    applied.length > 0
      ? `migrations applied: ${applied.join(", ")}`
      : added.length > 0
        ? `migrations: ${added.join(", ")} already applied`
        : "migrations: none";
  const functionsNote = functions.length > 0 ? `functions deployed: ${functions.join(", ")}` : "functions: none";
  text = [`Deployed ${merged}`, migrationsNote, fnSecretsNote, functionsNote, botNote, secretsNote]
    .filter((part) => part !== null)
    .join(" · ");
} else {
  const where = failedStep ?? "an unknown step";
  const partial = applied.length > 0 ? ` Migrations that did apply before the failure: ${applied.join(", ")}.` : "";
  text = `DEPLOY FAILED for ${merged} at step "${where}".${partial} Nothing after that step ran. ${secretsNote}. Logs: ${env.RUN_URL ?? "(no run url)"}`;
}

console.log(text);

const botUrl = (env.BOT_URL ?? "").trim().replace(/\/+$/, "");
const secret = env.BOT_ADMIN_SECRET ?? "";
if (!botUrl || !secret) {
  console.log(
    "::warning::Could not post to #studio-admin: BOT_URL and/or ADMIN_SECRET are not in the vault (nor the legacy BOT_URL / BOT_ADMIN_SECRET repo secrets). The deploy result above stands.",
  );
  process.exit(0);
}

let res;
try {
  res = await fetch(`${botUrl}/admin/notify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ text, level: ok ? "info" : "error" }),
    signal: AbortSignal.timeout(20_000),
  });
} catch (err) {
  console.log(`::error::POST ${botUrl}/admin/notify failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
let body = {};
try {
  body = await res.json();
} catch {
  // Non-JSON reply — the status code carries the verdict.
}
if (!res.ok || body.ok !== true) {
  console.log(`::error::/admin/notify answered HTTP ${res.status}: ${body.error ?? "no error detail"}`);
  process.exit(1);
}
console.log(`posted to #${body.channel ?? "studio-admin"} (ts ${body.ts ?? "?"})`);
