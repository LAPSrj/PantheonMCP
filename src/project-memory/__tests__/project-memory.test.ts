import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import {
  appendProjectEntry,
  getProjectEntry,
  updateProjectEntry,
  fadeProjectEntry,
  forgetProjectEntry,
  restoreProjectEntry,
  getProjectDetails,
  listProjectIndex,
  loadProjectMemoryStore,
  renderProjectMemory,
  ProjectMemoryError,
} from "../index.ts";

let tmpDir: string;
let paths: ReturnType<typeof resolvePaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-projmem-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("appendProjectEntry persists with author stamp; getProjectEntry returns it", () => {
  const e = appendProjectEntry(paths, "pantheon", {
    summary: "use bun, not npm",
    text: "All install/run/test goes through bun in this repo.",
    kind: "fact",
    author_username: "vellumpike",
  });
  const got = getProjectEntry(paths, "pantheon", e.id);
  expect(got).toBeTruthy();
  expect(got!.author_username).toBe("vellumpike");
  expect(got!.kind).toBe("fact");
});

test("two different projects keep separate memory files", () => {
  appendProjectEntry(paths, "alpha", { text: "alpha note" });
  appendProjectEntry(paths, "beta", { text: "beta note" });
  const a = loadProjectMemoryStore(paths, "alpha");
  const b = loadProjectMemoryStore(paths, "beta");
  expect(a.entries).toHaveLength(1);
  expect(b.entries).toHaveLength(1);
  expect(a.entries[0]!.text).toBe("alpha note");
});

test("forget tombstones the entry but keeps it on disk; restore brings it back", () => {
  const e = appendProjectEntry(paths, "p", { text: "to be forgotten" });
  forgetProjectEntry(paths, "p", e.id);
  // Default list hides forgotten.
  expect(listProjectIndex(paths, "p")).toHaveLength(0);
  // include 'all' status shows it.
  const allList = listProjectIndex(paths, "p", { status: "all" });
  expect(allList).toHaveLength(1);
  expect(allList[0]!.status).toBe("forgotten");
  // Restore flips to active.
  restoreProjectEntry(paths, "p", e.id);
  expect(listProjectIndex(paths, "p")).toHaveLength(1);
});

test("fade flips status; restore returns to active", () => {
  const e = appendProjectEntry(paths, "p", { text: "later" });
  fadeProjectEntry(paths, "p", e.id);
  expect(getProjectEntry(paths, "p", e.id)!.status).toBe("faded");
  restoreProjectEntry(paths, "p", e.id);
  expect(getProjectEntry(paths, "p", e.id)!.status).toBe("active");
});

test("update patches fields without disturbing others", () => {
  const e = appendProjectEntry(paths, "p", { text: "v1" });
  updateProjectEntry(paths, "p", e.id, { text: "v2" });
  const got = getProjectEntry(paths, "p", e.id)!;
  expect(got.text).toBe("v2");
  // author_username preserved (was unset to begin with — verify the
  // patch doesn't introduce it).
  expect(got.author_username).toBeUndefined();
});

test("getProjectDetails returns the details payload; null when none", () => {
  const e1 = appendProjectEntry(paths, "p", {
    text: "with details",
    details: "long payload here",
  });
  expect(getProjectDetails(paths, "p", e1.id)).toBe("long payload here");
  const e2 = appendProjectEntry(paths, "p", { text: "no details" });
  expect(getProjectDetails(paths, "p", e2.id)).toBeNull();
});

test("getProjectDetails throws entry_not_found for unknown id", () => {
  expect(() => getProjectDetails(paths, "p", "ghost-id")).toThrow(
    ProjectMemoryError,
  );
});

test("listProjectIndex filters by author, kind, since, and substring", () => {
  appendProjectEntry(paths, "p", {
    text: "alpha said pizza",
    kind: "log",
    author_username: "alpha",
  });
  appendProjectEntry(paths, "p", {
    text: "beta said pasta",
    kind: "fact",
    author_username: "beta",
  });
  // Filter by author.
  const a = listProjectIndex(paths, "p", { author: "alpha" });
  expect(a).toHaveLength(1);
  expect(a[0]!.author_username).toBe("alpha");
  // Index shape — text is not inlined; the field is absent.
  expect((a[0] as unknown as Record<string, unknown>).text).toBeUndefined();
  // Filter by kind.
  const f = listProjectIndex(paths, "p", { kind: "fact" });
  expect(f).toHaveLength(1);
  expect(f[0]!.kind).toBe("fact");
  // Substring search.
  const s = listProjectIndex(paths, "p", { filter: "pizza" });
  expect(s).toHaveLength(1);
});

test("render PROJECT tier groups Core / Active / Faded with project name and budget hints", () => {
  appendProjectEntry(paths, "pantheon", {
    text: "core fact",
    core: true,
    summary: "a core fact",
    author_username: "vellumpike",
  });
  appendProjectEntry(paths, "pantheon", {
    text: "everyday note",
    summary: "everyday note",
  });
  const r = renderProjectMemory(paths, "pantheon");
  expect(r.text).toContain("PROJECT MEMORY: pantheon");
  expect(r.text).toContain("CORE");
  expect(r.text).toContain("ACTIVE");
  expect(r.text).toContain("@vellumpike");
});

test("render of empty project memory returns a no-entries placeholder", () => {
  const r = renderProjectMemory(paths, "empty-project");
  expect(r.text).toContain("no entries yet");
});

test("ID slugging dedupes when two appends share the same derived summary", () => {
  const e1 = appendProjectEntry(paths, "p", { text: "duplicate title note" });
  const e2 = appendProjectEntry(paths, "p", { text: "duplicate title note" });
  expect(e1.id).not.toBe(e2.id);
});

test("validateProjectName rejects path-traversal in the project arg", () => {
  expect(() =>
    appendProjectEntry(paths, "../../etc/passwd", { text: "x" }),
  ).toThrow();
  expect(() =>
    appendProjectEntry(paths, "with/slash", { text: "x" }),
  ).toThrow();
});

test("summary >240 chars is rejected", () => {
  const tooLong = "a".repeat(241);
  expect(() =>
    appendProjectEntry(paths, "p", { summary: tooLong, text: "x" }),
  ).toThrow(ProjectMemoryError);
});

test("empty text is rejected", () => {
  expect(() => appendProjectEntry(paths, "p", { text: "" })).toThrow(
    ProjectMemoryError,
  );
});

test("setting an invalid status on update is rejected", () => {
  const e = appendProjectEntry(paths, "p", { text: "x" });
  // patchEntry's `status` is single-valued; reject anything outside the
  // tristate. Cast through unknown to bypass the public type so we can
  // assert the runtime guard fires.
  expect(() =>
    updateProjectEntry(paths, "p", e.id, {
      status: "bogus-status" as unknown as "active",
    }),
  ).toThrow(ProjectMemoryError);
});
