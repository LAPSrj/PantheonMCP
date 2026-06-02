import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { appendEntry } from "../../memory/operations.ts";
import { mutateStore } from "../../memory/store.ts";
import { ensureDataDirs, ensurePersonaDir } from "../../storage/paths.ts";
import { createPersona } from "../../identity/registry.ts";
import { buildResumeSummary, buildCoreMemory } from "../index.ts";

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

// --- buildCoreMemory ------------------------------------------------- //

test("buildCoreMemory: empty when no entries", () => {
  expect(buildCoreMemory(paths, "alpha")).toEqual({ entries: [] });
});

test("buildCoreMemory: returns active core entries with full text", () => {
  appendEntry(paths, "alpha", {
    summary: "rail",
    text: "the full rail body",
    kind: "posture-rail",
    core: true,
  });
  appendEntry(paths, "alpha", { summary: "non-core", text: "x" });
  const core = buildCoreMemory(paths, "alpha");
  expect(core.entries).toHaveLength(1);
  expect(core.entries[0]).toMatchObject({
    summary: "rail",
    kind: "posture-rail",
    text: "the full rail body",
  });
  expect(core.truncated).toBeUndefined();
});

test("buildCoreMemory: excludes faded/forgotten core entries", () => {
  appendEntry(paths, "alpha", { summary: "active", text: "x", core: true });
  appendEntry(paths, "alpha", { summary: "gone", text: "x", core: true });
  mutateStore(paths, "alpha", (store) => {
    const t = store.entries.find((e) => e.summary === "gone");
    if (t) t.status = "faded";
    return store;
  });
  const core = buildCoreMemory(paths, "alpha");
  expect(core.entries.map((e) => e.summary)).toEqual(["active"]);
});

test("buildCoreMemory: sorted ascending by date", () => {
  for (let i = 0; i < 4; i++) {
    appendEntry(paths, "alpha", { summary: `c${i}`, text: "x", core: true });
  }
  mutateStore(paths, "alpha", (store) => {
    store.entries.forEach((e, idx) => {
      e.date = `2026-04-${(20 + idx).toString().padStart(2, "0")}`;
    });
    return store;
  });
  const core = buildCoreMemory(paths, "alpha");
  expect(core.entries.map((e) => e.summary)).toEqual(["c0", "c1", "c2", "c3"]);
});

test("buildCoreMemory: drops oldest entries over the total budget, counts them", () => {
  const big = "y".repeat(2 * 1024);
  for (let i = 0; i < 8; i++) {
    appendEntry(paths, "alpha", { summary: `c${i}`, text: big, core: true });
  }
  mutateStore(paths, "alpha", (store) => {
    store.entries.forEach((e, idx) => {
      e.date = `2026-04-${(20 + idx).toString().padStart(2, "0")}`;
    });
    return store;
  });
  const core = buildCoreMemory(paths, "alpha");
  // 8 x 2 KB = 16 KB > 12 KB budget — some dropped, NOT emitted as refs.
  expect(core.entries.length).toBeLessThan(8);
  expect(core.truncated).toEqual({ total: 8, shown: core.entries.length });
  // Every emitted entry carries full text; newest survive.
  for (const e of core.entries) expect(e.text).toBe(big);
  expect(core.entries.at(-1)?.summary).toBe("c7");
  expect(core.entries.some((e) => e.summary === "c0")).toBe(false);
});

test("buildCoreMemory: drops any single oversized body past the per-entry cap", () => {
  appendEntry(paths, "alpha", {
    summary: "doc",
    text: "z".repeat(5 * 1024),
    core: true,
  });
  appendEntry(paths, "alpha", {
    summary: "rail",
    text: "small body",
    core: true,
  });
  const core = buildCoreMemory(paths, "alpha");
  expect(core.entries.map((e) => e.summary)).toEqual(["rail"]);
  expect(core.truncated).toEqual({ total: 2, shown: 1 });
});

test("buildCoreMemory: excludes kind:handoff entries (they surface in handoffs)", () => {
  appendEntry(paths, "alpha", {
    summary: "a rule",
    text: "rule body",
    core: true,
  });
  appendEntry(paths, "alpha", {
    summary: "a handoff",
    text: "handoff body",
    kind: "handoff",
    core: true,
  });
  const core = buildCoreMemory(paths, "alpha");
  expect(core.entries.map((e) => e.summary)).toEqual(["a rule"]);
});

// --- handoffs in resume summary ------------------------------------- //

test("handoffs: empty when no handoff entries", () => {
  appendEntry(paths, "alpha", { summary: "rule", text: "x", core: true });
  expect(buildResumeSummary(paths, "alpha").handoffs).toEqual([]);
});

test("handoffs: lists active handoff entries newest-first with summary", () => {
  appendEntry(paths, "alpha", {
    summary: "older handoff",
    text: "x",
    kind: "handoff",
    core: true,
  });
  appendEntry(paths, "alpha", {
    summary: "newer handoff",
    text: "y",
    kind: "handoff",
    core: true,
    expires_at: 1779000000000,
  });
  mutateStore(paths, "alpha", (store) => {
    const older = store.entries.find((e) => e.summary === "older handoff");
    const newer = store.entries.find((e) => e.summary === "newer handoff");
    if (older) older.date = "2026-04-20";
    if (newer) newer.date = "2026-04-22";
    return store;
  });
  const h = buildResumeSummary(paths, "alpha").handoffs;
  expect(h.map((e) => e.summary)).toEqual(["newer handoff", "older handoff"]);
  expect(h[0]?.expires_at).toBe(1779000000000);
  expect(h[1]?.expires_at).toBeNull();
});

test("handoffs: excludes faded handoff entries", () => {
  appendEntry(paths, "alpha", {
    summary: "live",
    text: "x",
    kind: "handoff",
    core: true,
  });
  appendEntry(paths, "alpha", {
    summary: "stale",
    text: "x",
    kind: "handoff",
    core: true,
  });
  mutateStore(paths, "alpha", (store) => {
    const t = store.entries.find((e) => e.summary === "stale");
    if (t) t.status = "faded";
    return store;
  });
  const h = buildResumeSummary(paths, "alpha").handoffs;
  expect(h.map((e) => e.summary)).toEqual(["live"]);
});

// --- memory_index --------------------------------------------------- //

test("memory_index: groups active entries by kind, bodyless refs", () => {
  appendEntry(paths, "alpha", { summary: "d1", text: "x", kind: "decision" });
  appendEntry(paths, "alpha", { summary: "d2", text: "x", kind: "decision" });
  appendEntry(paths, "alpha", { summary: "g1", text: "x", kind: "gotcha" });
  appendEntry(paths, "alpha", { summary: "u1", text: "x" });
  const idx = buildResumeSummary(paths, "alpha").memory_index;
  expect(idx.decision?.map((e) => e.summary).sort()).toEqual(["d1", "d2"]);
  expect(idx.gotcha?.map((e) => e.summary)).toEqual(["g1"]);
  expect(idx._unspecified?.map((e) => e.summary)).toEqual(["u1"]);
  // Refs are bodyless — id/date/summary only.
  expect(Object.keys(idx.gotcha![0]!).sort()).toEqual(["date", "id", "summary"]);
});

test("memory_index: includes core entries, excludes handoffs", () => {
  appendEntry(paths, "alpha", {
    summary: "rail",
    text: "x",
    kind: "decision",
    core: true,
  });
  appendEntry(paths, "alpha", {
    summary: "h",
    text: "x",
    kind: "handoff",
  });
  appendEntry(paths, "alpha", { summary: "note", text: "x", kind: "log" });
  const idx = buildResumeSummary(paths, "alpha").memory_index;
  // Core entry IS in the catalog; handoff is NOT.
  expect(Object.keys(idx).sort()).toEqual(["decision", "log"]);
  expect(idx.decision?.map((e) => e.summary)).toEqual(["rail"]);
});

test("memory_index: excludes faded entries", () => {
  appendEntry(paths, "alpha", { summary: "live", text: "x", kind: "fact" });
  appendEntry(paths, "alpha", { summary: "gone", text: "x", kind: "fact" });
  mutateStore(paths, "alpha", (store) => {
    const t = store.entries.find((e) => e.summary === "gone");
    if (t) t.status = "faded";
    return store;
  });
  const idx = buildResumeSummary(paths, "alpha").memory_index;
  expect(idx.fact?.map((e) => e.summary)).toEqual(["live"]);
});

test("memory_index: stops at the 14 KB byte budget, surfaces truncation", () => {
  // 240-char summaries (~300 B/ref with id+date) — ~100 entries
  // overshoots the 14 KB budget comfortably.
  const fatSummary = "s".repeat(240);
  for (let i = 0; i < 100; i++) {
    appendEntry(paths, "alpha", { summary: fatSummary, text: "x", kind: "log" });
  }
  const r = buildResumeSummary(paths, "alpha");
  const shown = Object.values(r.memory_index).reduce(
    (n, arr) => n + arr.length,
    0,
  );
  expect(r.memory_index_truncated).toEqual({ total: 100, shown });
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(100);
  // Rendered index bytes stay within ~one entry of the 14 KB budget.
  const bytes = Object.values(r.memory_index)
    .flat()
    .reduce((n, e) => n + Buffer.byteLength(e.id + e.date + e.summary), 0);
  expect(bytes).toBeLessThanOrEqual(14 * 1024 + 320);
});

test("memory_index: no truncation metadata when within cap", () => {
  appendEntry(paths, "alpha", { summary: "e", text: "x", kind: "log" });
  expect(buildResumeSummary(paths, "alpha").memory_index_truncated).toBeUndefined();
});

