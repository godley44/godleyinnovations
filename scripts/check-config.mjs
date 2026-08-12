// Guard script: validates the module config against the SQL migrations.
// Catches the runtime-only mistakes a compiler can't: a tab pointing at a
// table no migration creates, a select list that drifted from the database's
// CHECK constraint, a money field on a non-cents column, duplicate slugs.
// Runs as part of `npm run check` before every push.
//
// Node 22 strips TS types natively, so this imports the real config —
// the exact object the app ships — not a copy that could drift.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES } from "../src/modules/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");

// Comments are stripped before parsing: option lists in migrations carry
// explanatory comments, and a ")" inside one would truncate the regex match.
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, "");

const failures = [];

// Tables created by migrations.
const createdTables = new Set(
  [...sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)/gi)].map((m) =>
    m[1].toLowerCase(),
  ),
);

// CHECK ... IN (...) option lists per column, per table.
function sqlOptionsFor(table, column) {
  // Find the table's create statement, then the column's check-in list.
  const tableMatch = sql.match(
    new RegExp(`create table (?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  if (!tableMatch) return null;
  const colMatch = tableMatch[1].match(
    new RegExp(`${column}[\\s\\S]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([\\s\\S]*?)\\)`, "i"),
  );
  if (!colMatch) return null;
  return [...colMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const slugs = new Set();
for (const mod of MODULES) {
  if (slugs.has(mod.slug)) failures.push(`Duplicate module slug: ${mod.slug}`);
  slugs.add(mod.slug);
  if (mod.slug === "overview") {
    failures.push(`Module slug "overview" collides with the built-in Overview tab.`);
  }

  const sectionIds = new Set();
  for (const sec of mod.sections) {
    const where = `[${mod.slug} / ${sec.id}]`;
    if (sectionIds.has(sec.id)) failures.push(`${where} duplicate section id`);
    sectionIds.add(sec.id);

    if (!createdTables.has(sec.table.toLowerCase())) {
      failures.push(`${where} table "${sec.table}" is not created by any migration`);
      continue;
    }

    if (sec.scope !== "venture") {
      const { parentTable, fkColumn } = sec.scope.via;
      if (!createdTables.has(parentTable.toLowerCase())) {
        failures.push(`${where} parent table "${parentTable}" is not created by any migration`);
      }
      if (!sec.fields.some((f) => f.key === fkColumn)) {
        failures.push(`${where} scope.via.fkColumn "${fkColumn}" has no matching field`);
      }
    }

    const fieldKeys = new Set();
    for (const field of sec.fields) {
      if (fieldKeys.has(field.key)) failures.push(`${where} duplicate field key "${field.key}"`);
      fieldKeys.add(field.key);

      // Money fields must write *_cents columns; anything else means someone
      // is about to store floating-point dollars.
      if (field.type === "money" && !field.key.endsWith("_cents")) {
        failures.push(`${where} money field "${field.key}" must end in _cents`);
      }

      // Fixed select options must exactly match the database CHECK list, or
      // inserts will start bouncing after the next migration drifts.
      if (field.type === "select" && field.options) {
        const dbOptions = sqlOptionsFor(sec.table, field.key);
        if (dbOptions) {
          const a = [...field.options].sort().join(",");
          const b = [...dbOptions].sort().join(",");
          if (a !== b) {
            failures.push(
              `${where} options for "${field.key}" (${a}) don't match the SQL CHECK constraint (${b})`,
            );
          }
        } else {
          failures.push(
            `${where} select field "${field.key}" has hardcoded options but no CHECK constraint in SQL — add one or drop the options`,
          );
        }
      }
    }

    // Every fixed (lens) value must be allowed by the SQL CHECK constraint.
    for (const [col, val] of Object.entries(sec.fixed ?? {})) {
      const dbOptions = sqlOptionsFor(sec.table, col);
      if (dbOptions && !dbOptions.includes(val)) {
        failures.push(
          `${where} fixed value ${col}='${val}' is not allowed by the SQL CHECK constraint (${dbOptions.join(", ")})`,
        );
      }
    }
  }
}

// Beyond the module config: every table (.from("x")) and database function
// (.rpc("y")) referenced anywhere in app or edge-function code must be
// created by a migration. Catches the screen-with-no-table-behind-it class
// of bug for code that doesn't go through the module config.
const createdFunctions = new Set(
  [...sql.matchAll(/create (?:or replace )?function (?:public\.)?(\w+)/gi)].map((m) =>
    m[1].toLowerCase(),
  ),
);

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|js|mjs)$/.test(e.name))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}
const code = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "supabase", "functions"))]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

for (const m of code.matchAll(/\.from\(\s*"([a-z_]+)"/g)) {
  if (!createdTables.has(m[1])) {
    failures.push(`code references table "${m[1]}" but no migration creates it`);
  }
}
for (const m of code.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)) {
  if (!createdFunctions.has(m[1])) {
    failures.push(`code calls database function "${m[1]}" but no migration creates it`);
  }
}

if (failures.length > 0) {
  console.error("check-config FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(
  `check-config OK: ${MODULES.length} modules + all table/function references validated against migrations.`,
);
