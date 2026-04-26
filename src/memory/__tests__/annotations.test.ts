import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  appendEntry,
  MemoryError,
  renderForPrompt,
  updateEntry,
  loadStore,
  fadeEntry,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-annotations-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("appendEntry persists replies_to and see_also when refs exist", () => {
  const a = appendEntry(paths, USER, { text: "first decision" });
  const b = appendEntry(paths, USER, { text: "second" });
  const c = appendEntry(paths, USER, {
    text: "third",
    replies_to: a.id,
    see_also: [b.id],
  });
  expect(c.replies_to).toBe(a.id);
  expect(c.see_also).toEqual([b.id]);
});

test("appendEntry rejects invalid_reference for unknown replies_to", () => {
  let err: unknown;
  try {
    appendEntry(paths, USER, { text: "x", replies_to: "ghost-id" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("invalid_reference");
});

test("appendEntry rejects invalid_reference for unknown see_also id", () => {
  const a = appendEntry(paths, USER, { text: "anchor" });
  let err: unknown;
  try {
    appendEntry(paths, USER, { text: "x", see_also: [a.id, "ghost-id"] });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("invalid_reference");
});

test("updateEntry can set / clear replies_to and see_also", () => {
  const a = appendEntry(paths, USER, { text: "anchor" });
  const b = appendEntry(paths, USER, { text: "child" });
  const updated = updateEntry(paths, USER, b.id, {
    replies_to: a.id,
    see_also: [a.id],
  });
  expect(updated.replies_to).toBe(a.id);
  expect(updated.see_also).toEqual([a.id]);
  // Clear via null.
  const cleared = updateEntry(paths, USER, b.id, {
    replies_to: null,
    see_also: null,
  });
  expect(cleared.replies_to).toBeUndefined();
  expect(cleared.see_also).toBeUndefined();
});

test("updateEntry rejects invalid_reference on bad replies_to", () => {
  const a = appendEntry(paths, USER, { text: "x" });
  let err: unknown;
  try {
    updateEntry(paths, USER, a.id, { replies_to: "ghost-id" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MemoryError);
  expect((err as MemoryError).code).toBe("invalid_reference");
});

test("renderForPrompt: faded child entry indents under parent in Index synopsis", () => {
  const a = appendEntry(paths, USER, { text: "anchor for thread" });
  const b = appendEntry(paths, USER, {
    text: "follow-up reply",
    replies_to: a.id,
  });
  // Fade both so they land in the Index tier.
  fadeEntry(paths, USER, a.id);
  fadeEntry(paths, USER, b.id);
  const r = renderForPrompt(paths, USER);
  // Child line begins with `↳`.
  expect(r.text).toContain(`↳ [${b.id}]`);
});

test("renderForPrompt: see_also cites in the index synopsis", () => {
  const a = appendEntry(paths, USER, { text: "anchor" });
  const b = appendEntry(paths, USER, {
    text: "annotated",
    see_also: [a.id],
  });
  fadeEntry(paths, USER, b.id);
  const r = renderForPrompt(paths, USER);
  expect(r.text).toContain(`[see_also: ${a.id}]`);
});

test("see_also persists as a copy (caller-side mutation doesn't leak)", () => {
  const a = appendEntry(paths, USER, { text: "anchor" });
  const refs = [a.id];
  const b = appendEntry(paths, USER, { text: "annotated", see_also: refs });
  refs.push("mutated-after-append");
  const reloaded = loadStore(paths, USER).entries.find((e) => e.id === b.id);
  expect(reloaded?.see_also).toEqual([a.id]);
});
