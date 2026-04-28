/** Schema registry persistence.
 *
 * Schemas live in a single JSON file at `<paths.root>/schemas.json`,
 * keyed by id. Atomic mutate-then-rename writes; reader retries on
 * parse failure (mirrors the memory store's pattern). The JSON
 * format is hand-editable — schema bodies are arbitrary JSON, no
 * pantheon-specific shape beyond `{id, description?, schema, ...}`.
 *
 * Concurrent-write contract: same as memory — last write wins; we
 * read, mutate, rename. Cross-process schema authoring is rare
 * enough that more is overkill. */

import fs from "node:fs";
import path from "node:path";
import type { Paths } from "../storage/paths.ts";
import { SchemaError, type JsonSchema, type Schema } from "./types.ts";

interface RegistryFile {
  version: 1;
  schemas: Record<string, Schema>;
}

const ID_PATTERN = /^[A-Za-z0-9_./@:\-]+$/;

function registryFilePath(paths: Paths): string {
  return path.join(paths.root, "schemas.json");
}

function readRegistryFile(paths: Paths): RegistryFile {
  const filePath = registryFilePath(paths);
  if (!fs.existsSync(filePath)) {
    return { version: 1, schemas: {} };
  }
  // Single short retry on parse failure — same pattern memory uses
  // for concurrent-write races (mid-rename atomicity window).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed.version !== 1) {
        throw new Error(`Unknown schemas.json version ${parsed.version}`);
      }
      if (!parsed.schemas || typeof parsed.schemas !== "object") {
        return { version: 1, schemas: {} };
      }
      return parsed;
    } catch {
      if (attempt === 0) {
        // Brief sleep-y retry — schemas.json should rename-atomically
        // settle within microseconds. A second read almost always
        // succeeds. Bun has no sync sleep; busy-wait <5ms.
        const until = Date.now() + 5;
        while (Date.now() < until) { /* spin */ }
        continue;
      }
      return { version: 1, schemas: {} };
    }
  }
  return { version: 1, schemas: {} };
}

function writeRegistryFile(paths: Paths, file: RegistryFile): void {
  fs.mkdirSync(paths.root, { recursive: true });
  const dest = registryFilePath(paths);
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dest);
}

export function listSchemas(paths: Paths): Schema[] {
  const file = readRegistryFile(paths);
  return Object.values(file.schemas).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

export function getSchema(paths: Paths, id: string): Schema | null {
  const file = readRegistryFile(paths);
  return file.schemas[id] ?? null;
}

export interface RegisterOptions {
  id: string;
  schema: JsonSchema;
  description?: string;
  /** When true, error if a schema with this id already exists. When
   * false (default), replace it. Replacement preserves `created_at`
   * and bumps `updated_at`. */
  exclusive?: boolean;
  clock?: () => number;
}

export function registerSchema(paths: Paths, options: RegisterOptions): Schema {
  const id = options.id.trim();
  if (!ID_PATTERN.test(id)) {
    throw new SchemaError(
      "invalid_schema_id",
      `Schema id '${id}' contains disallowed characters. Allowed: A-Z, a-z, 0-9, '_', '.', '/', '@', ':', '-'.`,
    );
  }
  if (!isPlainObject(options.schema)) {
    throw new SchemaError(
      "invalid_schema_body",
      "`schema` must be a JSON object.",
    );
  }
  const clock = options.clock ?? Date.now;
  const file = readRegistryFile(paths);
  const existing = file.schemas[id];
  if (existing && options.exclusive) {
    throw new SchemaError(
      "schema_already_exists",
      `Schema '${id}' is already registered. Pass exclusive:false (default) to replace, or pick a different id.`,
      { id },
    );
  }
  const now = clock();
  const next: Schema = {
    id,
    schema: options.schema,
    ...(options.description !== undefined ? { description: options.description } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  file.schemas[id] = next;
  writeRegistryFile(paths, file);
  return next;
}

export function unregisterSchema(paths: Paths, id: string): boolean {
  const file = readRegistryFile(paths);
  if (!(id in file.schemas)) return false;
  delete file.schemas[id];
  writeRegistryFile(paths, file);
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
