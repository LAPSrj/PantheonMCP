import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import {
  getSchema,
  listSchemas,
  registerSchema,
  unregisterSchema,
  SchemaError,
} from "../index.ts";

let tmpDir: string;
let paths: ReturnType<typeof resolvePaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-schemas-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("registerSchema persists then getSchema returns it", () => {
  registerSchema(paths, {
    id: "takt-starter/pushback@v1",
    schema: { type: "object", required: ["pattern"] },
    description: "pushback claim",
  });
  const got = getSchema(paths, "takt-starter/pushback@v1");
  expect(got).toBeTruthy();
  expect(got!.description).toBe("pushback claim");
  expect(got!.schema.required).toEqual(["pattern"]);
});

test("listSchemas returns all registered, sorted by id", () => {
  registerSchema(paths, { id: "b/x@v1", schema: { type: "object" } });
  registerSchema(paths, { id: "a/x@v1", schema: { type: "object" } });
  const list = listSchemas(paths);
  expect(list.map((s) => s.id)).toEqual(["a/x@v1", "b/x@v1"]);
});

test("registerSchema replaces existing by default; preserves created_at", () => {
  const t1 = 1_000_000;
  registerSchema(paths, {
    id: "a@v1",
    schema: { type: "object" },
    clock: () => t1,
  });
  const t2 = t1 + 5_000;
  registerSchema(paths, {
    id: "a@v1",
    schema: { type: "object", required: ["x"] },
    clock: () => t2,
  });
  const got = getSchema(paths, "a@v1")!;
  expect(got.created_at).toBe(t1);
  expect(got.updated_at).toBe(t2);
  expect(got.schema.required).toEqual(["x"]);
});

test("registerSchema with exclusive:true rejects existing id", () => {
  registerSchema(paths, { id: "a@v1", schema: { type: "object" } });
  expect(() =>
    registerSchema(paths, {
      id: "a@v1",
      schema: { type: "object" },
      exclusive: true,
    }),
  ).toThrow(SchemaError);
});

test("unregisterSchema removes entry; returns false when absent", () => {
  registerSchema(paths, { id: "a@v1", schema: { type: "object" } });
  expect(unregisterSchema(paths, "a@v1")).toBe(true);
  expect(getSchema(paths, "a@v1")).toBeNull();
  expect(unregisterSchema(paths, "a@v1")).toBe(false);
});

test("registerSchema validates id charset", () => {
  expect(() =>
    registerSchema(paths, { id: "bad id with spaces", schema: { type: "object" } }),
  ).toThrow(SchemaError);
});

test("registerSchema rejects non-object schema body", () => {
  expect(() =>
    registerSchema(paths, {
      id: "a@v1",
      schema: "not-an-object" as unknown as Parameters<typeof registerSchema>[1]["schema"],
    }),
  ).toThrow(SchemaError);
});

test("registry survives across paths.resolve calls (persisted to disk)", () => {
  registerSchema(paths, { id: "p/q@v1", schema: { type: "object" } });
  const reloaded = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  const got = getSchema(reloaded, "p/q@v1");
  expect(got).toBeTruthy();
});
