// Guard script: the AI Mesh Bot's two safety invariants are runtime behavior
// no compiler sees — losing either one recreates the infinite-AI-reply loop
// or silently widens OS write access. These are textual checks and therefore
// blunt, but they fail loudly if the guard code (or its GUARD markers) is
// deleted or renamed, which is the failure mode that actually happens during
// refactors. If a check fires on a legitimate refactor, update the check in
// the same commit and say why in the commit message.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const botPath = join(root, "services", "ai-mesh-bot", "index.js");
const src = readFileSync(botPath, "utf8");

const failures = [];

// The file must at least parse — it has no build step of its own.
const syntax = spawnSync(process.execPath, ["--check", botPath], { encoding: "utf8" });
if (syntax.status !== 0) failures.push(`index.js has a syntax error:\n${syntax.stderr}`);

// Invariant 1: mention-only + no-bot-echo (the loop breakers).
if (!src.includes("GUARD:mention-only") || !/event\.type !== "app_mention"/.test(src)) {
  failures.push("mention-only guard (GUARD:mention-only + app_mention check) is missing");
}
if (!src.includes("GUARD:no-bot-echo") || !/event\.bot_id/.test(src)) {
  failures.push("no-bot-echo guard (GUARD:no-bot-echo + bot_id check) is missing");
}

// Invariant 2: only claude writes to the OS.
if (!src.includes("GUARD:os-write-claude-only") || !/persona === "claude"/.test(src)) {
  failures.push("OS write gate (GUARD:os-write-claude-only + persona check) is missing");
}
const canWriteTrue = src.match(/canWriteOS:\s*true/g) ?? [];
if (canWriteTrue.length !== 1) {
  failures.push(`exactly one persona may have canWriteOS: true (found ${canWriteTrue.length})`);
}
if (!/claude:\s*\{[^}]*canWriteOS:\s*true/.test(src)) {
  failures.push("the canWriteOS: true persona must be claude");
}
if ((src.match(/writeToOS\(/g) ?? []).length > 2) {
  // One definition + one call site keeps the access boundary auditable at a
  // glance; a second call site is how the gate gets bypassed by accident.
  failures.push("writeToOS() has more than one call site — the claude-only gate guards a single call site by design");
}

if (failures.length > 0) {
  console.error("check-mesh-bot FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("check-mesh-bot OK: loop guards and OS write boundary intact.");
