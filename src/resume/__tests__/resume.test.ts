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

// --- notebook TOC integration --------------------------------------- //

test("notebooks field omitted when persona has no notebook entries", () => {
  const r = buildResumeSummary(paths, "alpha");
  expect(r.notebooks).toBeUndefined();
  expect(r.notebooks_truncated).toBeUndefined();
});

test("notebooks field populated and sorted by last_touched_at desc", async () => {
  const { writePage } = await import("../../notebook/index.ts");
  writePage(paths, "alpha", { topic: "older", title: "A", body: "a" });
  // Tiny delay so updated_at differs.
  await new Promise((res) => setTimeout(res, 5));
  writePage(paths, "alpha", { topic: "newer", title: "B", body: "b" });

  const r = buildResumeSummary(paths, "alpha");
  expect(r.notebooks?.map((n) => n.slug)).toEqual(["newer", "older"]);
  expect(r.notebooks?.[0]?.page_count).toBe(1);
});

test("notebooks TOC caps at notebook_toc_limit; truncated metadata surfaces", async () => {
  const { writePage } = await import("../../notebook/index.ts");
  for (let i = 0; i < 25; i++) {
    writePage(paths, "alpha", { topic: `t-${i}`, title: "T", body: "b" });
  }
  const r = buildResumeSummary(paths, "alpha", { notebook_toc_limit: 20 });
  expect(r.notebooks).toHaveLength(20);
  expect(r.notebooks_truncated).toEqual({ total: 25, shown: 20 });
});

test("project_notebooks populated only when project option provided and topics exist", async () => {
  const { writeProjectPage } = await import(
    "../../project-notebook/index.ts"
  );
  writeProjectPage(paths, "X", {
    topic: "shared",
    title: "S",
    body: "s",
    author_username: "alpha",
  });

  // No project option → not loaded
  const noProj = buildResumeSummary(paths, "alpha");
  expect(noProj.project_notebooks).toBeUndefined();

  const withProj = buildResumeSummary(paths, "alpha", { project: "X" });
  expect(withProj.project_notebooks).toHaveLength(1);
  expect(withProj.project_notebooks?.[0]?.slug).toBe("shared");
});

test("project_notebooks omitted when project has no topics", () => {
  const r = buildResumeSummary(paths, "alpha", { project: "X" });
  expect(r.project_notebooks).toBeUndefined();
});
