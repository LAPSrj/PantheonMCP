import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import { openChatDb, resolvePaths } from "../../storage/index.ts";
import {
  getSchema,
  listSchemas,
  registerSchema,
  unregisterSchema,
  importLegacySchemas,
  LEGACY_GLOBAL_PROJECT,
  SchemaError,
} from "../index.ts";

let tmpDir: string;
let paths: ReturnType<typeof resolvePaths>;
let db: Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-schemas-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  db = openChatDb(paths.chatDbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("registerSchema persists then getSchema returns it (project-scoped)", () => {
  registerSchema(db, {
    project: "alpha",
    id: "takt-starter/pushback@v1",
    schema: { type: "object", required: ["pattern"] },
    description: "pushback claim",
  });
  const got = getSchema(db, "alpha", "takt-starter/pushback@v1");
  expect(got).toBeTruthy();
  expect(got!.description).toBe("pushback claim");
  expect(got!.schema.required).toEqual(["pattern"]);
});

test("schemas in one project are invisible to another (except via legacy fallback)", () => {
  registerSchema(db, {
    project: "alpha",
    id: "a/x@v1",
    schema: { type: "object" },
  });
  expect(getSchema(db, "beta", "a/x@v1")).toBeNull();
});

test("listSchemas returns the caller's project + legacy fallback, sorted, deduped", () => {
  registerSchema(db, { project: "alpha", id: "b/x@v1", schema: { type: "object" } });
  registerSchema(db, { project: "alpha", id: "a/x@v1", schema: { type: "object" } });
  registerSchema(db, {
    project: LEGACY_GLOBAL_PROJECT,
    id: "legacy/y@v1",
    schema: { type: "object" },
  });
  // A legacy entry shadowed by a project-scoped entry of the same id —
  // expect the project entry to win in listSchemas.
  registerSchema(db, {
    project: LEGACY_GLOBAL_PROJECT,
    id: "a/x@v1",
    schema: { type: "object", description: "legacy version" },
  });
  const list = listSchemas(db, "alpha");
  expect(list.map((s) => s.id)).toEqual(["a/x@v1", "b/x@v1", "legacy/y@v1"]);
});

test("registerSchema replaces existing by default; preserves created_at", () => {
  const t1 = 1_000_000;
  registerSchema(db, {
    project: "p",
    id: "a@v1",
    schema: { type: "object" },
    clock: () => t1,
  });
  const t2 = t1 + 5_000;
  registerSchema(db, {
    project: "p",
    id: "a@v1",
    schema: { type: "object", required: ["x"] },
    clock: () => t2,
  });
  const got = getSchema(db, "p", "a@v1")!;
  expect(got.created_at).toBe(t1);
  expect(got.updated_at).toBe(t2);
  expect(got.schema.required).toEqual(["x"]);
});

test("registerSchema with exclusive:true rejects existing id in same project", () => {
  registerSchema(db, { project: "p", id: "a@v1", schema: { type: "object" } });
  expect(() =>
    registerSchema(db, {
      project: "p",
      id: "a@v1",
      schema: { type: "object" },
      exclusive: true,
    }),
  ).toThrow(SchemaError);
});

test("exclusive:true does NOT collide with the same id in a DIFFERENT project", () => {
  registerSchema(db, { project: "alpha", id: "a@v1", schema: { type: "object" } });
  expect(() =>
    registerSchema(db, {
      project: "beta",
      id: "a@v1",
      schema: { type: "object" },
      exclusive: true,
    }),
  ).not.toThrow();
});

test("unregisterSchema removes only the caller's project entry", () => {
  registerSchema(db, { project: "alpha", id: "a@v1", schema: { type: "object" } });
  registerSchema(db, { project: "beta", id: "a@v1", schema: { type: "object" } });
  expect(unregisterSchema(db, "alpha", "a@v1")).toBe(true);
  expect(getSchema(db, "alpha", "a@v1")).toBeNull();
  // Beta's entry survives.
  expect(getSchema(db, "beta", "a@v1")).toBeTruthy();
  // Re-delete is a no-op (no row to remove).
  expect(unregisterSchema(db, "alpha", "a@v1")).toBe(false);
});

test("registerSchema validates id charset", () => {
  expect(() =>
    registerSchema(db, {
      project: "p",
      id: "bad id with spaces",
      schema: { type: "object" },
    }),
  ).toThrow(SchemaError);
});

test("registerSchema rejects non-object schema body", () => {
  expect(() =>
    registerSchema(db, {
      project: "p",
      id: "a@v1",
      schema: "not-an-object" as unknown as Parameters<typeof registerSchema>[1]["schema"],
    }),
  ).toThrow(SchemaError);
});

test("registry survives reopen (persisted in chat.db)", () => {
  registerSchema(db, { project: "p", id: "p/q@v1", schema: { type: "object" } });
  db.close();
  db = openChatDb(paths.chatDbPath);
  const got = getSchema(db, "p", "p/q@v1");
  expect(got).toBeTruthy();
});

test("getSchema falls back to __legacy_global__ when project-scoped misses", () => {
  registerSchema(db, {
    project: LEGACY_GLOBAL_PROJECT,
    id: "legacy/y@v1",
    schema: { type: "object", description: "the old way" },
  });
  // From a fresh project that has never registered this id.
  const got = getSchema(db, "alpha", "legacy/y@v1");
  expect(got).toBeTruthy();
  expect(got!.id).toBe("legacy/y@v1");
});

test("project-scoped entry shadows __legacy_global__ for the same id in getSchema", () => {
  registerSchema(db, {
    project: LEGACY_GLOBAL_PROJECT,
    id: "x@v1",
    schema: { type: "object" },
    description: "legacy",
  });
  registerSchema(db, {
    project: "alpha",
    id: "x@v1",
    schema: { type: "object" },
    description: "alpha-owned",
  });
  const got = getSchema(db, "alpha", "x@v1")!;
  expect(got.description).toBe("alpha-owned");
});

test("importLegacySchemas reads ~/.pantheon/schemas.json and seeds __legacy_global__", () => {
  // Write a pre-v7 schemas.json into the sandbox root.
  const filePath = path.join(paths.root, "schemas.json");
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      schemas: {
        "old/a@v1": {
          id: "old/a@v1",
          description: "imported from disk",
          schema: { type: "object", required: ["x"] },
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
        "old/b@v1": {
          id: "old/b@v1",
          schema: { type: "object" },
          created_at: 1_700_000_001_000,
          updated_at: 1_700_000_001_000,
        },
      },
    }),
  );
  const n = importLegacySchemas(db, paths);
  expect(n).toBe(2);
  const a = getSchema(db, "any-project", "old/a@v1");
  expect(a).toBeTruthy();
  expect(a!.description).toBe("imported from disk");
  expect(a!.created_at).toBe(1_700_000_000_000);

  // Idempotency: second import doesn't overwrite or duplicate.
  expect(importLegacySchemas(db, paths)).toBe(2);
  const a2 = getSchema(db, "any-project", "old/a@v1")!;
  expect(a2.created_at).toBe(1_700_000_000_000);
});

test("importLegacySchemas silently no-ops when the file is missing or corrupt", () => {
  // No file written → 0.
  expect(importLegacySchemas(db, paths)).toBe(0);
  // Corrupt JSON → 0, no throw.
  const filePath = path.join(paths.root, "schemas.json");
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(filePath, "{ this is not valid json");
  expect(importLegacySchemas(db, paths)).toBe(0);
});
