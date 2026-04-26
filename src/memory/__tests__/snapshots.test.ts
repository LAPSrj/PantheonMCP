import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  appendEntry,
  deleteSnapshot,
  listSnapshots,
  loadStore,
  MemoryError,
  restoreMemory,
  setMemory,
  snapshotMemory,
  validateLabel,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-snapshots-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("validateLabel rejects bad shapes", () => {
  for (const bad of ["", " label", "lab/el", "-leading", ".dot", "a".repeat(65)]) {
    expect(() => validateLabel(bad)).toThrow(MemoryError);
  }
});

test("snapshotMemory writes a parallel JSON next to the main store", () => {
  appendEntry(paths, USER, { text: "first decision" });
  const meta = snapshotMemory(paths, USER, "v1");
  expect(meta.label).toBe("v1");
  expect(meta.size_bytes).toBeGreaterThan(0);
  const file = path.join(paths.personasDir, USER, "memory.snapshots", "v1.json");
  expect(fs.existsSync(file)).toBe(true);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(parsed.version).toBe(1);
  expect(parsed.entries).toHaveLength(1);
});

test("restoreMemory overwrites the main store with the snapshot's contents", () => {
  appendEntry(paths, USER, { text: "alpha" });
  snapshotMemory(paths, USER, "before");
  setMemory(paths, USER, { text: "wiped — clean slate" });
  expect(loadStore(paths, USER).entries.map((e) => e.text)).toEqual([
    "wiped — clean slate",
  ]);

  const result = restoreMemory(paths, USER, "before");
  expect(result.restored_label).toBe("before");
  expect(result.entry_count).toBe(1);
  expect(loadStore(paths, USER).entries[0]?.text).toBe("alpha");
});

test("restoreMemory errors entry_not_found for unknown label", () => {
  let err: unknown;
  try {
    restoreMemory(paths, USER, "ghost");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("entry_not_found");
});

test("listSnapshots returns metadata sorted newest-first", async () => {
  appendEntry(paths, USER, { text: "x" });
  snapshotMemory(paths, USER, "earlier");
  await new Promise((r) => setTimeout(r, 5));
  snapshotMemory(paths, USER, "later");
  const list = listSnapshots(paths, USER);
  expect(list.map((s) => s.label)).toEqual(["later", "earlier"]);
});

test("listSnapshots returns empty when persona has no snapshots", () => {
  expect(listSnapshots(paths, USER)).toEqual([]);
});

test("deleteSnapshot removes the file and returns true; idempotent", () => {
  appendEntry(paths, USER, { text: "x" });
  snapshotMemory(paths, USER, "v1");
  expect(deleteSnapshot(paths, USER, "v1")).toBe(true);
  expect(deleteSnapshot(paths, USER, "v1")).toBe(false);
  expect(listSnapshots(paths, USER)).toEqual([]);
});
