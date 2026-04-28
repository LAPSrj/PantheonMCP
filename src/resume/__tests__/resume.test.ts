import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { appendEntry } from "../../memory/operations.ts";
import { mutateStore } from "../../memory/store.ts";
import { ensureDataDirs, ensurePersonaDir } from "../../storage/paths.ts";
import { createPersona } from "../../identity/registry.ts";
import { buildResumeSummary } from "../index.ts";

let tmpDir: string;
let paths: ReturnType<typeof resolvePaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-resume-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ensureDataDirs(paths);
  // Set up a persona so the memory file path is valid.
  createPersona(paths, {
    username: "alpha",
    project: "X",
    cwd: "/work/alpha",
    platform: "linux",
    description: "tester",
    expertise: [],
    owns: [],
  });
  ensurePersonaDir(paths, "alpha");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("empty memory: zero counts, empty recent_memory", () => {
  const r = buildResumeSummary(paths, "alpha");
  expect(r.active_memory_count).toBe(0);
  expect(r.recent_memory).toEqual([]);
  expect(r.memory_by_kind).toEqual({});
});

test("counts active entries by kind, ignores faded/forgotten", () => {
  appendEntry(paths, "alpha", { summary: "a1", text: "x", kind: "decision" });
  appendEntry(paths, "alpha", { summary: "a2", text: "x", kind: "decision" });
  appendEntry(paths, "alpha", { summary: "a3", text: "x", kind: "retraction" });
  appendEntry(paths, "alpha", { summary: "a4", text: "x" });
  // Mark one decision as faded.
  mutateStore(paths, "alpha", (store) => {
    const target = store.entries.find((e) => e.summary === "a1");
    if (target) target.status = "faded";
    return store;
  });
  const r = buildResumeSummary(paths, "alpha");
  expect(r.active_memory_count).toBe(3);
  expect(r.memory_by_kind).toEqual({
    decision: 1,
    retraction: 1,
    _unspecified: 1,
  });
});

test("recent_memory: sorted date-desc, capped to limit", () => {
  for (let i = 0; i < 8; i++) {
    appendEntry(paths, "alpha", { summary: `m${i}`, text: "x" });
  }
  // Override dates so we can verify sort order independently of the
  // append insertion ordering.
  mutateStore(paths, "alpha", (store) => {
    store.entries.forEach((e, idx) => {
      e.date = `2026-04-${(20 + idx).toString().padStart(2, "0")}`;
    });
    return store;
  });
  const r = buildResumeSummary(paths, "alpha", { recent_memory_limit: 3 });
  expect(r.recent_memory).toHaveLength(3);
  expect(r.recent_memory.map((e) => e.summary)).toEqual(["m7", "m6", "m5"]);
});

test("recent_memory entry shape: id/date/summary/kind/core/has_details", () => {
  appendEntry(paths, "alpha", {
    summary: "decision",
    text: "x",
    kind: "decision",
    core: true,
    details: "long details",
  });
  const r = buildResumeSummary(paths, "alpha");
  expect(r.recent_memory[0]).toMatchObject({
    summary: "decision",
    kind: "decision",
    core: true,
    has_details: true,
  });
});
