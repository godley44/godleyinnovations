// Bot version for the health probe, read from package.json so it can never
// disagree with what npm thinks is deployed. The path works from both dist/
// (runtime) and src/ (tsx dev): two levels up is the package root either way.

import { readFileSync } from "node:fs";

export const BOT_VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
})();
