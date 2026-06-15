import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  appendEntry,
  updateEntry,
  amendEntry,
  fadeEntry,
  getEntry,
  getHistory,
  getHistoryRevision,
  buildHistory,
  lineDiff,
  MemoryError,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-history-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("fresh entry has no revisions", () => {
  const e = appendEntry(paths, USER, { text: "original body", topic: "t" });
  expect(e.revisions).toBeUndefined();
  const h = getHistory(paths, USER, e.id)!;
  expect(h.tip).toBe(0);
  // Timeline of a never-edited entry is just the current tip, shown full.
  expect(h.timeline.length).toBe(1);
  expect(h.timeline[0]!.current).toBe(true);
  expect(h.timeline[0]!.full!.text).toBe("original body");
});

test("update records the prior state as a full revision", () => {
  const e = appendEntry(paths, USER, { text: "v0 body", topic: "t" });
  updateEntry(paths, USER, e.id, { text: "v1 body" });
  const stored = getEntry(paths, USER, e.id)!;
  expect(stored.text).toBe("v1 body");
  expect(stored.revisions!.length).toBe(1);
  expect(stored.revisions![0]!.rev).toBe(0);
  expect(stored.revisions![0]!.snapshot.text).toBe("v0 body");
  expect(stored.revisions![0]!.changed).toContain("text");
});

test("multiple edits accumulate; timeline is first-full then diffs", () => {
  const e = appendEntry(paths, USER, { text: "line a\nline b", topic: "t" });
  updateEntry(paths, USER, e.id, { text: "line a\nline B" });
  updateEntry(paths, USER, e.id, { text: "line a\nline B\nline c" });
  const h = getHistory(paths, USER, e.id)!;
  expect(h.tip).toBe(2);
  expect(h.timeline.length).toBe(3);
  // rev 0 full, no diff.
  expect(h.timeline[0]!.full!.text).toBe("line a\nline b");
  expect(h.timeline[0]!.diff).toBeUndefined();
  // later revs carry a diff, no full.
  expect(h.timeline[1]!.full).toBeUndefined();
  expect(h.timeline[1]!.diff!.text).toContain("- line b");
  expect(h.timeline[1]!.diff!.text).toContain("+ line B");
  expect(h.timeline[2]!.diff!.text).toContain("+ line c");
  expect(h.timeline[2]!.current).toBe(true);
});

test("no-op update records no revision", () => {
  const e = appendEntry(paths, USER, { text: "same", topic: "t" });
  updateEntry(paths, USER, e.id, { text: "same" });
  const stored = getEntry(paths, USER, e.id)!;
  expect(stored.revisions).toBeUndefined();
});

test("scalar field changes are tracked in the diff", () => {
  const e = appendEntry(paths, USER, { text: "body", topic: "t", kind: "note" });
  updateEntry(paths, USER, e.id, { kind: "fact" });
  const h = getHistory(paths, USER, e.id)!;
  expect(h.timeline[1]!.diff!.fields!.kind).toEqual({ from: "note", to: "fact" });
});

test("fade is recorded as a status revision", () => {
  const e = appendEntry(paths, USER, { text: "body", topic: "t" });
  fadeEntry(paths, USER, e.id);
  const h = getHistory(paths, USER, e.id)!;
  expect(h.timeline[1]!.diff!.fields!.status).toEqual({ from: "active", to: "faded" });
});

test("getHistoryRevision returns full content for any revision index", () => {
  const e = appendEntry(paths, USER, { text: "v0", topic: "t" });
  updateEntry(paths, USER, e.id, { text: "v1" });
  updateEntry(paths, USER, e.id, { text: "v2" });
  expect(getHistoryRevision(paths, USER, e.id, 0)!.content.text).toBe("v0");
  expect(getHistoryRevision(paths, USER, e.id, 1)!.content.text).toBe("v1");
  // tip index returns the current live content.
  expect(getHistoryRevision(paths, USER, e.id, 2)!.content.text).toBe("v2");
});

test("getHistoryRevision out of range throws", () => {
  const e = appendEntry(paths, USER, { text: "v0", topic: "t" });
  expect(() => getHistoryRevision(paths, USER, e.id, 5)).toThrow(MemoryError);
});

test("amendEntry appends server-side and records a revision", () => {
  const e = appendEntry(paths, USER, { text: "first", topic: "t" });
  const r = amendEntry(paths, USER, e.id, { add: "second" });
  expect(r.text).toBe("first\n\nsecond");
  expect(r.revisions!.length).toBe(1);
  expect(r.revisions![0]!.snapshot.text).toBe("first");
});

test("amendEntry prepend + stamp + custom separator", () => {
  const e = appendEntry(paths, USER, { text: "body", topic: "t" });
  const r1 = amendEntry(paths, USER, e.id, { add: "head", position: "start", separator: " | " });
  expect(r1.text).toBe("head | body");
  const r2 = amendEntry(paths, USER, e.id, { add: "logged", stamp: true });
  expect(r2.text).toMatch(/head \| body\n\n- \d{4}-\d{2}-\d{2}: logged/);
});

test("amendEntry rejects empty add", () => {
  const e = appendEntry(paths, USER, { text: "body", topic: "t" });
  expect(() => amendEntry(paths, USER, e.id, { add: "" })).toThrow(MemoryError);
});

test("history travels with the stored entry across reloads", () => {
  const e = appendEntry(paths, USER, { text: "v0", topic: "t" });
  updateEntry(paths, USER, e.id, { text: "v1" });
  // Reload from disk via a fresh paths handle.
  const fresh = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  const reloaded = getEntry(fresh, USER, e.id)!;
  expect(reloaded.revisions!.length).toBe(1);
  expect(buildHistory(reloaded).length).toBe(2);
});

test("PANTHEON_MEMORY_HISTORY opt-out disables capture", () => {
  const prev = process.env.PANTHEON_MEMORY_HISTORY;
  try {
    process.env.PANTHEON_MEMORY_HISTORY = "off";
    const e = appendEntry(paths, USER, { text: "v0", topic: "t" });
    updateEntry(paths, USER, e.id, { text: "v1" });
    amendEntry(paths, USER, e.id, { add: "more" });
    const stored = getEntry(paths, USER, e.id)!;
    expect(stored.text).toBe("v1\n\nmore"); // edits still apply
    expect(stored.revisions).toBeUndefined(); // but nothing recorded
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_MEMORY_HISTORY;
    else process.env.PANTHEON_MEMORY_HISTORY = prev;
  }
});

test("lineDiff marks added/removed/context lines", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc\nd");
  expect(d).toContain("  a");
  expect(d).toContain("- b");
  expect(d).toContain("+ B");
  expect(d).toContain("+ d");
});
