/** Project-scoped schema registry.
 *
 * Pantheon stores caller-registered JSON Schemas keyed by
 * `(project, schema_id)` in chat.db's `schemas` table (migration v7).
 * `register_schema` is bound to the caller's project; `get_schema` /
 * `list_schemas` / `unregister_schema` operate on the caller's project
 * by default. Cross-project access (when added) uses `_any` variants —
 * mirrors the `summon` / `summon_any` pattern.
 *
 * Legacy `<paths.root>/schemas.json` (the pre-v7 file-backed registry)
 * is imported into project `__legacy_global__` on every chat.db open
 * while the file is present (see `importLegacySchemas`). Lookups fall
 * back to that project when a project-scoped match misses, so consumers
 * referencing globally-registered ids keep working until they
 * re-register under their own project.
 */

import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Paths } from "../storage/paths.ts";
import { SchemaError, type JsonSchema, type Schema } from "./types.ts";

/** Sentinel project used to house entries imported from the pre-v7
 * `schemas.json`. New code never writes here; reads fall through to
 * it when a project-scoped lookup misses. */
export const LEGACY_GLOBAL_PROJECT = "__legacy_global__";

const ID_PATTERN = /^[A-Za-z0-9_./@:\-]+$/;

interface SchemaRow {
  project: string;
  schema_id: string;
  body_json: string;
  description: string | null;
  registered_by: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSchema(row: SchemaRow): Schema {
  return {
    id: row.schema_id,
    schema: JSON.parse(row.body_json) as JsonSchema,
    ...(row.description !== null ? { description: row.description } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Return every schema visible to `project`: its own entries, plus
 * `__legacy_global__` entries it hasn't shadowed. Sorted by id. */
export function listSchemas(db: Database, project: string): Schema[] {
  const rows = db
    .query(
      `SELECT project, schema_id, body_json, description, registered_by, created_at, updated_at
       FROM schemas
       WHERE project = ? OR project = ?
       ORDER BY schema_id ASC`,
    )
    .all(project, LEGACY_GLOBAL_PROJECT) as SchemaRow[];
  // De-dupe: project-scoped row wins over a legacy entry of the same id.
  const byId = new Map<string, SchemaRow>();
  for (const row of rows) {
    const existing = byId.get(row.schema_id);
    if (!existing || existing.project === LEGACY_GLOBAL_PROJECT) {
      byId.set(row.schema_id, row);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => a.schema_id.localeCompare(b.schema_id))
    .map(rowToSchema);
}

/** Return the schema registered under `project` for this id; falls back
 * to `__legacy_global__` if the project-scoped lookup misses. */
export function getSchema(
  db: Database,
  project: string,
  id: string,
): Schema | null {
  const own = db
    .query(
      `SELECT project, schema_id, body_json, description, registered_by, created_at, updated_at
       FROM schemas WHERE project = ? AND schema_id = ?`,
    )
    .get(project, id) as SchemaRow | undefined;
  if (own) return rowToSchema(own);
  if (project === LEGACY_GLOBAL_PROJECT) return null;
  const legacy = db
    .query(
      `SELECT project, schema_id, body_json, description, registered_by, created_at, updated_at
       FROM schemas WHERE project = ? AND schema_id = ?`,
    )
    .get(LEGACY_GLOBAL_PROJECT, id) as SchemaRow | undefined;
  return legacy ? rowToSchema(legacy) : null;
}

export interface RegisterOptions {
  project: string;
  id: string;
  schema: JsonSchema;
  description?: string;
  /** When true, error if a schema with this id already exists in the
   * caller's project. When false (default), replace it. Replacement
   * preserves `created_at` and bumps `updated_at`. The legacy
   * `__legacy_global__` entry (if any) is NOT consulted by exclusive
   * — re-registering an id that exists only in legacy is fine. */
  exclusive?: boolean;
  /** Optional caller identity (username) for blame. */
  registered_by?: string;
  clock?: () => number;
}

export function registerSchema(
  db: Database,
  options: RegisterOptions,
): Schema {
  const project = options.project;
  const id = options.id.trim();
  if (!project || project.length === 0) {
    throw new SchemaError(
      "invalid_schema_id",
      "registerSchema requires a non-empty project.",
    );
  }
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
  const now = clock();
  const existing = db
    .query(
      `SELECT created_at FROM schemas WHERE project = ? AND schema_id = ?`,
    )
    .get(project, id) as { created_at: number } | undefined;
  if (existing && options.exclusive) {
    throw new SchemaError(
      "schema_already_exists",
      `Schema '${id}' is already registered in project '${project}'. Pass exclusive:false (default) to replace, or pick a different id.`,
      { id, project },
    );
  }
  const created_at = existing?.created_at ?? now;
  const body_json = JSON.stringify(options.schema);
  db.run(
    `INSERT INTO schemas (project, schema_id, body_json, description, registered_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, schema_id) DO UPDATE SET
       body_json = excluded.body_json,
       description = excluded.description,
       registered_by = excluded.registered_by,
       updated_at = excluded.updated_at`,
    [
      project,
      id,
      body_json,
      options.description ?? null,
      options.registered_by ?? null,
      created_at,
      now,
    ],
  );
  return {
    id,
    schema: options.schema,
    ...(options.description !== undefined ? { description: options.description } : {}),
    created_at,
    updated_at: now,
  };
}

/** Remove a schema from `project`. Returns true when a row was deleted.
 * Does NOT touch `__legacy_global__` — legacy entries are removed via
 * `unregisterSchema(db, LEGACY_GLOBAL_PROJECT, id)` explicitly. */
export function unregisterSchema(
  db: Database,
  project: string,
  id: string,
): boolean {
  const res = db.run(
    `DELETE FROM schemas WHERE project = ? AND schema_id = ?`,
    [project, id],
  );
  return (res.changes ?? 0) > 0;
}

/** Import every entry from a pre-v7 `<paths.root>/schemas.json` into the
 * `schemas` table under `__legacy_global__`. Idempotent — already-
 * imported ids are upsert-no-op'd by `created_at` preservation. Safe to
 * call on every `openChatDb` while the file is present. Returns the
 * number of rows imported (or skipped because already present). The
 * file itself is NOT removed — old running pantheon processes still
 * read/write it; on next restart everyone is on chat.db.
 *
 * Returns 0 silently when the file doesn't exist or can't be parsed. */
export function importLegacySchemas(db: Database, paths: Paths): number {
  const filePath = path.join(paths.root, "schemas.json");
  if (!fs.existsSync(filePath)) return 0;
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("schemas" in (parsed as Record<string, unknown>))
  ) {
    return 0;
  }
  const schemas = (parsed as { schemas?: Record<string, unknown> }).schemas;
  if (!schemas || typeof schemas !== "object") return 0;
  let count = 0;
  const insert = db.prepare(
    `INSERT INTO schemas (project, schema_id, body_json, description, registered_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT (project, schema_id) DO NOTHING`,
  );
  for (const [id, raw] of Object.entries(schemas)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const body = entry.schema;
    if (!isPlainObject(body)) continue;
    const description =
      typeof entry.description === "string" ? entry.description : null;
    const created_at =
      typeof entry.created_at === "number" ? entry.created_at : Date.now();
    const updated_at =
      typeof entry.updated_at === "number" ? entry.updated_at : created_at;
    insert.run(
      LEGACY_GLOBAL_PROJECT,
      id,
      JSON.stringify(body),
      description,
      created_at,
      updated_at,
    );
    count++;
  }
  return count;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
