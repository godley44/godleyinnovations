// Guard script: migrations are run by hand, in order, so the files must make
// that unambiguous. Fails on gaps or duplicate numbers (two 003s means the
// wrong one gets run), and on obviously destructive statements sneaking into
// a migration without a loud marker.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "supabase", "migrations");

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const failures = [];

const numbers = [];
for (const f of files) {
  const m = f.match(/^(\d{3})_[a-z0-9_]+\.sql$/);
  if (!m) {
    failures.push(`"${f}" doesn't match NNN_name.sql — numbering is how you know what to run next`);
    continue;
  }
  numbers.push(Number(m[1]));
}

const sorted = [...numbers].sort((a, b) => a - b);
for (let i = 0; i < sorted.length; i++) {
  if (i > 0 && sorted[i] === sorted[i - 1]) {
    failures.push(`Two migrations share number ${String(sorted[i]).padStart(3, "0")}`);
  }
  if (sorted[i] !== i + 1 && sorted[i] !== sorted[i - 1]) {
    failures.push(
      `Migration numbers have a gap: expected ${String(i + 1).padStart(3, "0")}, found ${String(sorted[i]).padStart(3, "0")}`,
    );
  }
}

// Destructive SQL is allowed only when deliberately marked, so a careless
// paste can't silently drop production data.
for (const f of files) {
  const text = readFileSync(join(dir, f), "utf8");
  if (/\b(drop\s+table|truncate|delete\s+from)\b/i.test(text) && !text.includes("-- DESTRUCTIVE: yes I mean it")) {
    failures.push(
      `"${f}" contains destructive SQL without the marker comment "-- DESTRUCTIVE: yes I mean it"`,
    );
  }
}

if (failures.length > 0) {
  console.error("check-migrations FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`check-migrations OK: ${files.length} migration file(s), numbering sound.`);
