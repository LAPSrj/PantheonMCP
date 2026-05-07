import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** §6 HIGH — stale-MCP-proxy mitigation. Instructional copy lives in
 * markdown templates next to this file (so a daemon restart picks up
 * edits without requiring every Claude Code conversation to restart
 * its MCP proxy). Tool handlers call `getResponseTemplate(name)`
 * instead of inlining string literals.
 *
 * Templates are loaded lazily (first access) and cached by name. Pass
 * `interpolate` for `{{key}}` substitution; values are JSON.stringified
 * if non-string to avoid surprises.
 */
const cache = new Map<string, string>();

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(here, "templates");

// Repo-root-relative paths the templates may interpolate. Resolved
// from this file's location so the values track the install rather
// than any one developer's checkout. (`src/responses/templates.ts`
// → `<repo>/bin/pantheon-fetch.ts`.)
const repoRoot = path.resolve(here, "..", "..");
export const PANTHEON_BIN_DIR = path.join(repoRoot, "bin");
export const PANTHEON_FETCH_BIN = path.join(PANTHEON_BIN_DIR, "pantheon-fetch.ts");

export function getResponseTemplate(
  name: string,
  interpolate?: Record<string, unknown>,
): string {
  let raw = cache.get(name);
  if (raw === undefined) {
    raw = fs.readFileSync(path.join(templatesDir, `${name}.md`), "utf8");
    cache.set(name, raw);
  }
  if (!interpolate) return raw;
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = interpolate[key];
    if (value === undefined) return `{{${key}}}`;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/** Test hook: clear the cache so file edits or reset-tests see fresh
 * templates. Production code should NOT call this. */
export function _clearTemplateCache(): void {
  cache.clear();
}

export function listTemplateNames(): string[] {
  try {
    return fs
      .readdirSync(templatesDir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3));
  } catch {
    return [];
  }
}
