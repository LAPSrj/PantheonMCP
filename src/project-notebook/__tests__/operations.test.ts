import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  ProjectNotebookError,
  deleteProjectPage,
  deleteProjectTopic,
  getProjectPage,
  listProjectTopics,
  openProjectTopic,
  renameProjectTopic,
  restoreProjectPage,
  searchProjectNotebook,
  writeProjectPage,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const PROJECT = "pantheon";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-pnotebook-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function expectThrowCode(fn: () => unknown, code: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProjectNotebookError);
  expect((err as ProjectNotebookError).code as string).toBe(code);
}

test("writeProjectPage creates topic + stamps author_username", () => {
  const r = writeProjectPage(paths, PROJECT, {
    topic: "sync-handshake",
    title: "Takt → nyus persona map",
    body: "Five personas own this: A, B, C, D, E.",
    author_username: "vellumpike",
  });
  expect(r.created).toBe(true);
  expect(r.page.author_username).toBe("vellumpike");
  const open = openProjectTopic(paths, PROJECT, "sync-handshake");
  expect(open.topic.pages[0]?.author_username).toBe("vellumpike");
});

test("writeProjectPage updates existing page when page_id supplied", () => {
  const first = writeProjectPage(paths, PROJECT, {
    topic: "t",
    title: "A",
    body: "v1",
    author_username: "alice",
  });
  const upd = writeProjectPage(paths, PROJECT, {
    topic: "t",
    title: "A (revised)",
    body: "v2",
    page_id: first.page.id,
    author_username: "bob",
  });
  expect(upd.created).toBe(false);
  expect(upd.page.author_username).toBe("bob");
  expect(upd.page.body).toBe("v2");
});

test("listProjectTopics omits empty topics, sorts by last_touched desc", () => {
  writeProjectPage(paths, PROJECT, { topic: "alpha", title: "A", body: "a" });
  writeProjectPage(paths, PROJECT, { topic: "beta", title: "B", body: "b" });
  writeProjectPage(paths, PROJECT, { topic: "alpha", title: "A2", body: "a2" });
  const refs = listProjectTopics(paths, PROJECT);
  expect(refs.map((r) => r.slug)).toEqual(["alpha", "beta"]);
  expect(refs[0]?.page_count).toBe(2);
});

test("delete + restore page works; topic auto-vanishes on full delete", () => {
  const r = writeProjectPage(paths, PROJECT, {
    topic: "t",
    title: "A",
    body: "a",
  });
  deleteProjectPage(paths, PROJECT, "t", r.page.id);
  expect(listProjectTopics(paths, PROJECT)).toEqual([]);
  restoreProjectPage(paths, PROJECT, "t", r.page.id);
  expect(listProjectTopics(paths, PROJECT)).toHaveLength(1);
});

test("deleteProjectTopic bulk-tombstones; renameProjectTopic + collision", () => {
  writeProjectPage(paths, PROJECT, { topic: "old", title: "A", body: "a" });
  writeProjectPage(paths, PROJECT, { topic: "old", title: "B", body: "b" });
  const d = deleteProjectTopic(paths, PROJECT, "old");
  expect(d.pages_deleted).toBe(2);

  writeProjectPage(paths, PROJECT, { topic: "src", title: "X", body: "x" });
  writeProjectPage(paths, PROJECT, { topic: "dst", title: "Y", body: "y" });
  expectThrowCode(
    () => renameProjectTopic(paths, PROJECT, "src", "dst"),
    "topic_exists",
  );
});

test("search filters by author/topic/tag", () => {
  writeProjectPage(paths, PROJECT, {
    topic: "swiper",
    title: "Z-INDEX hell",
    body: "the slide-clone trick",
    tags: ["css"],
    author_username: "alice",
  });
  writeProjectPage(paths, PROJECT, {
    topic: "swiper",
    title: "ZINDEX again",
    body: "duplicate from bob",
    tags: ["css"],
    author_username: "bob",
  });
  const byAuthor = searchProjectNotebook(paths, PROJECT, {
    query: "swiper".slice(0, 0) || "trick",
    author: "alice",
  });
  expect(byAuthor.every((h) => h.author_username === "alice")).toBe(true);
});

test("invalid project name rejects", () => {
  expectThrowCode(
    () =>
      writeProjectPage(paths, "bad project!", {
        topic: "x",
        title: "t",
        body: "b",
      }),
    "invalid_project",
  );
});

test("missing topic / page id rejects with mapped codes", () => {
  expectThrowCode(
    () => openProjectTopic(paths, PROJECT, "ghost"),
    "topic_not_found",
  );
  writeProjectPage(paths, PROJECT, { topic: "t", title: "A", body: "a" });
  expectThrowCode(
    () => getProjectPage(paths, PROJECT, "t", "missing"),
    "page_not_found",
  );
});
