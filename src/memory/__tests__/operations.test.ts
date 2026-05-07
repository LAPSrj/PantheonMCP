import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  MemoryError,
  appendEntry,
  deriveSummary,
  fadeEntry,
  forgetEntry,
  getDetails,
  getEntry,
  listIndex,
  recallEntry,
  setMemory,
  updateEntry,
  DETAILS_MAX_BYTES,
  SUMMARY_MAX_CHARS,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-memory-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- append + persistence ---

test("appendEntry persists with derived summary, status active, no core", () => {
  const entry = appendEntry(paths, USER, {
    text: "First decision: bun + TS strict.\n\nMore detail here.",
  });
  expect(entry.summary).toBe("First decision: bun + TS strict.");
  expect(entry.status).toBe("active");
  expect(entry.core).toBeUndefined();
  expect(entry.id).toMatch(/first-decision/);

  const reloaded = getEntry(paths, USER, entry.id);
  expect(reloaded).toEqual(entry);
});

test("appendEntry honors explicit summary, kind, core, summoner_username, details", () => {
  const entry = appendEntry(paths, USER, {
    summary: "explicit summary",
    text: "body",
    details: "verbatim quote here",
    kind: "decision",
    core: true,
    summoner_username: "alice",
  });
  expect(entry.summary).toBe("explicit summary");
  expect(entry.kind).toBe("decision");
  expect(entry.core).toBe(true);
  expect(entry.summoner_username).toBe("alice");
  expect(entry.details).toBe("verbatim quote here");
});

test("appendEntry rejects missing text", () => {
  let err: unknown;
  try {
    appendEntry(paths, USER, { text: "" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("missing_text");
});

test("appendEntry rejects summary > SUMMARY_MAX_CHARS", () => {
  let err: unknown;
  try {
    appendEntry(paths, USER, {
      summary: "x".repeat(SUMMARY_MAX_CHARS + 1),
      text: "body",
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("summary_too_long");
});

test("appendEntry rejects details > 5MB at the API boundary", () => {
  const tooBig = "a".repeat(DETAILS_MAX_BYTES + 1);
  let err: unknown;
  try {
    appendEntry(paths, USER, { text: "body", details: tooBig });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("entry_too_large");
});

test("appendEntry assigns unique ids on summary collisions", () => {
  const a = appendEntry(paths, USER, { summary: "ship plan", text: "v1" });
  const b = appendEntry(paths, USER, { summary: "ship plan", text: "v2" });
  expect(a.id).not.toBe(b.id);
  expect(b.id).toMatch(/^ship-plan/);
});

// --- update / fade / forget / recall ---

test("updateEntry patches whitelisted fields", () => {
  const entry = appendEntry(paths, USER, { text: "body" });
  const updated = updateEntry(paths, USER, entry.id, {
    summary: "renamed summary",
    text: "new body",
    kind: "fact",
    core: true,
  });
  expect(updated.summary).toBe("renamed summary");
  expect(updated.text).toBe("new body");
  expect(updated.kind).toBe("fact");
  expect(updated.core).toBe(true);
});

test("updateEntry can clear core (false removes the field) and clear details (null)", () => {
  const entry = appendEntry(paths, USER, {
    text: "body",
    core: true,
    details: "x",
  });
  const cleared = updateEntry(paths, USER, entry.id, { core: false, details: null });
  expect(cleared.core).toBeUndefined();
  expect(cleared.details).toBeUndefined();
});

test("fadeEntry / forgetEntry only mutate via explicit calls (no auto-fade)", () => {
  const entry = appendEntry(paths, USER, { text: "body" });
  expect(fadeEntry(paths, USER, entry.id).status).toBe("faded");
  expect(forgetEntry(paths, USER, entry.id).status).toBe("forgotten");
});

test("recallEntry returns the full entry and flips faded → active", () => {
  const entry = appendEntry(paths, USER, { text: "body" });
  fadeEntry(paths, USER, entry.id);
  const recalled = recallEntry(paths, USER, entry.id);
  expect(recalled.status).toBe("active");
  expect(recalled.text).toBe("body");
  // Persisted change.
  expect(getEntry(paths, USER, entry.id)?.status).toBe("active");
});

test("recallEntry on already-active is a no-op", () => {
  const entry = appendEntry(paths, USER, { text: "body" });
  const recalled = recallEntry(paths, USER, entry.id);
  expect(recalled.status).toBe("active");
});

test("recallEntry on missing id throws entry_not_found", () => {
  let err: unknown;
  try {
    recallEntry(paths, USER, "ghost");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("entry_not_found");
});

// --- details ---

test("getDetails returns ONLY the details field (not summary or text)", () => {
  const entry = appendEntry(paths, USER, {
    summary: "s",
    text: "t",
    details: "long verbatim payload",
  });
  expect(getDetails(paths, USER, entry.id)).toBe("long verbatim payload");
});

test("getDetails returns null when entry has no details", () => {
  const entry = appendEntry(paths, USER, { text: "body" });
  expect(getDetails(paths, USER, entry.id)).toBeNull();
});

// --- setMemory ---

test("setMemory replaces the entire entry list", () => {
  appendEntry(paths, USER, { text: "old" });
  appendEntry(paths, USER, { text: "older" });
  const fresh = setMemory(paths, USER, { text: "fresh start" });
  const all = listIndex(paths, USER);
  expect(all).toHaveLength(1);
  expect(all[0]?.id).toBe(fresh.id);
});

// --- listIndex ---

test("listIndex returns index shape sorted by date descending", async () => {
  appendEntry(paths, USER, { text: "first" });
  await new Promise((r) => setTimeout(r, 5));
  appendEntry(paths, USER, { text: "second" });
  await new Promise((r) => setTimeout(r, 5));
  const third = appendEntry(paths, USER, {
    text: "third",
    kind: "decision",
    core: true,
    details: "x",
  });

  const idx = listIndex(paths, USER);
  expect(idx).toHaveLength(3);
  expect(idx[0]?.id).toBe(third.id);
  // Verify date-descending order across the whole list.
  const dates = idx.map((i) => i.date);
  const sorted = [...dates].sort().reverse();
  expect(dates).toEqual(sorted);
  const top = idx[0]!;
  expect(top.core).toBe(true);
  expect(top.kind).toBe("decision");
  expect(top.has_details).toBe(true);
  expect(typeof top.size_kb).toBe("number");
});

test("listIndex filters by kind, core, status, since, filter substring", () => {
  appendEntry(paths, USER, { text: "alpha", kind: "decision" });
  appendEntry(paths, USER, { text: "beta gotcha", kind: "gotcha", core: true });
  fadeEntry(paths, USER, listIndex(paths, USER, { kind: "decision" })[0]!.id);

  expect(listIndex(paths, USER, { kind: "gotcha" })).toHaveLength(1);
  expect(listIndex(paths, USER, { core: true })).toHaveLength(1);
  expect(listIndex(paths, USER, { status: "faded" })).toHaveLength(1);
  expect(listIndex(paths, USER, { status: "all" })).toHaveLength(2);
  expect(listIndex(paths, USER, { filter: "GOTCHA" })).toHaveLength(1);
});

// --- deriveSummary ---

test("deriveSummary returns the first non-empty line, stripped of headings", () => {
  expect(deriveSummary("# Heading line\n\nbody")).toBe("Heading line");
  expect(deriveSummary("\n\nfirst real line\nsecond")).toBe("first real line");
});

test("deriveSummary truncates at the last sentence boundary that fits", () => {
  const one = "Sentence one. Sentence two. ";
  const fits = one.repeat(15);
  const got = deriveSummary(fits);
  expect(got.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  expect(got).toEndWith(".");
});

test("deriveSummary hard-trims with ellipsis when no sentence boundary present", () => {
  const noBoundary = "x".repeat(SUMMARY_MAX_CHARS + 50);
  const got = deriveSummary(noBoundary);
  expect(got.length).toBe(SUMMARY_MAX_CHARS);
  expect(got).toEndWith("…");
});
