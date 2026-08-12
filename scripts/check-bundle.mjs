// Guard script: run AFTER `npm run build` (CI does). Catches two silent
// bundle failures a compiler never sees:
//
// 1. The hollow-bundle bug: if VITE_SUPABASE_URL is undefined at build time,
//    Vite inlines `undefined`, the bundler proves `supabase` is always null,
//    and tree-shakes THE ENTIRE APP out of the bundle — build green, deploy
//    "works", every screen gone. So CI builds with placeholder env values and
//    this script asserts real app code made it into the output.
// 2. Secret leakage: the service-role key's env var name must never appear in
//    browser code. It shouldn't be possible (it's only read in the Deno edge
//    function) — this is the tripwire in case that ever changes.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(root, "dist", "assets");

let js;
try {
  js = readdirSync(assetsDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(assetsDir, f), "utf8"))
    .join("\n");
} catch {
  console.error("check-bundle FAILED: dist/assets not found — run `npm run build` first.");
  process.exit(1);
}

const failures = [];

// Sentinels from distinct corners of the real app; all must survive bundling.
for (const sentinel of ["Needs your approval", "apply_proposal", "money_ledger", "app is deployed but not connected"]) {
  if (!js.includes(sentinel)) {
    failures.push(
      `bundle is missing "${sentinel}" — the app was likely tree-shaken away (build without VITE_SUPABASE_URL set?)`,
    );
  }
}

if (js.includes("SERVICE_ROLE")) {
  failures.push("the service-role key env var name appears in browser code — that key must never reach the browser");
}

if (failures.length > 0) {
  console.error("check-bundle FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("check-bundle OK: full app present in bundle, no server secrets referenced.");
