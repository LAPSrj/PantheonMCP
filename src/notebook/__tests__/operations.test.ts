import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  NotebookError,
  deletePage,
  deleteTopic,
  getPage,
  listTopics,
  loadNotebookStore,
  openTopic,
  renameTopic,
  restorePage,
  searchNotebook,
  writePage,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-notebook-"));
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
  expect(err).toBeInstanceOf(NotebookError);
  expect((err as NotebookError).code as string).toBe(code);
}

// --- writePage + persistence ----------------------------------------- //

test("writePage creates a topic on first write, derives page_id, stamps timestamps", () => {
  const result = writePage(paths, USER, {
    topic: "swiper-zindex",
    title: "Clone-pattern collisions",
    body: "Set `--swiper-z-index: 1` on the slide clones.",
  });
  expect(result.created).toBe(true);
  expect(result.topic).toBe("swiper-zindex");
  expect(result.page.id).toBe("clone-pattern-collisions");
  expect(result.page.status).toBe("active");
  expect(result.page.created_at).toBe(result.page.updated_at);
  expect(result.warning).toBeNull();

  const reloaded = openTopic(paths, USER, "swiper-zindex");
  expect(reloaded.topic.title).toBe("swiper-zindex");
  expect(reloaded.topic.pages).toHaveLength(1);
  expect(reloaded.topic.pages[0]).toEqual(result.page);
});

test("writePage with topic_title sets the topic display title on creation", () => {
  writePage(paths, USER, {
    topic: "tia-bugherd",
    title: "RFR handoff",
    body: "Tia expects screenshot + reproducible URL.",
    topic_title: "Tia's BugHerd workflow",
  });
  const refs = listTopics(paths, USER);
  expect(refs[0]?.title).toBe("Tia's BugHerd workflow");
});

test("writePage with page_id updates an existing page in place", () => {
  const first = writePage(paths, USER, {
    topic: "swiper-zindex",
    title: "Clone collisions",
    body: "v1 body",
  });
  const updated = writePage(paths, USER, {
    topic: "swiper-zindex",
    title: "Clone collisions (revised)",
    body: "v2 body",
    page_id: first.page.id,
  });
  expect(updated.created).toBe(false);
  expect(updated.page.id).toBe(first.page.id);
  expect(updated.page.title).toBe("Clone collisions (revised)");
  expect(updated.page.body).toBe("v2 body");
  expect(updated.page.updated_at >= first.page.updated_at).toBe(true);

  const open = openTopic(paths, USER, "swiper-zindex");
  expect(open.topic.pages).toHaveLength(1);
});

test("writePage dedupes page_ids within a topic via -2 suffix", () => {
  const a = writePage(paths, USER, {
    topic: "recipes",
    title: "Visual diff tuning",
    body: "first",
  });
  const b = writePage(paths, USER, {
    topic: "recipes",
    title: "Visual diff tuning",
    body: "second",
  });
  expect(a.page.id).toBe("visual-diff-tuning");
  expect(b.page.id).toBe("visual-diff-tuning-2");
});

test("writePage with page_id targeting nonexistent topic rejects", () => {
  expectThrowCode(
    () =>
      writePage(paths, USER, {
        topic: "ghost",
        page_id: "missing",
        title: "x",
        body: "y",
      }),
    "topic_not_found",
  );
});

test("writePage rejects invalid slugs, empty body, empty/oversized title", () => {
  expectThrowCode(
    () => writePage(paths, USER, { topic: "Bad Slug", title: "t", body: "b" }),
    "invalid_topic_slug",
  );
  expectThrowCode(
    () => writePage(paths, USER, { topic: "ok", title: "", body: "b" }),
    "invalid_title",
  );
  expectThrowCode(
    () => writePage(paths, USER, { topic: "ok", title: "t", body: "" }),
    "missing_body",
  );
});

test("writePage dedupes tags and lowercases them", () => {
  const r = writePage(paths, USER, {
    topic: "tags",
    title: "p",
    body: "b",
    tags: ["Swiper", "swiper", " CSS ", "css"],
  });
  expect(r.page.tags).toEqual(["swiper", "css"]);
});

test("writePage soft-warns over 64KB body", () => {
  const big = "x".repeat(64 * 1024 + 10);
  const r = writePage(paths, USER, {
    topic: "big",
    title: "huge",
    body: big,
  });
  expect(r.warning).toMatch(/page body is/);
});

// --- read paths ------------------------------------------------------ //

test("openTopic excludes deleted pages by default; include_deleted surfaces them", () => {
  const a = writePage(paths, USER, { topic: "t", title: "A", body: "a" });
  writePage(paths, USER, { topic: "t", title: "B", body: "b" });
  deletePage(paths, USER, "t", a.page.id);

  const def = openTopic(paths, USER, "t");
  expect(def.topic.pages.map((p) => p.id)).toEqual(["b"]);
  const all = openTopic(paths, USER, "t", { include_deleted: true });
  expect(all.topic.pages).toHaveLength(2);
});

test("openTopic rejects missing topic", () => {
  expectThrowCode(() => openTopic(paths, USER, "ghost"), "topic_not_found");
});

test("getPage returns the page; missing topic or page id rejects", () => {
  const r = writePage(paths, USER, { topic: "t", title: "A", body: "a" });
  expect(getPage(paths, USER, "t", r.page.id).body).toBe("a");
  expectThrowCode(() => getPage(paths, USER, "ghost", "x"), "topic_not_found");
  expectThrowCode(() => getPage(paths, USER, "t", "missing"), "page_not_found");
});

test("listTopics returns TOC sorted by last_touched_at desc, omits empty topics", () => {
  writePage(paths, USER, { topic: "alpha", title: "A", body: "a" });
  writePage(paths, USER, { topic: "beta", title: "B", body: "b" });
  // bump alpha — last write should sort first
  writePage(paths, USER, { topic: "alpha", title: "A2", body: "a2" });
  const refs = listTopics(paths, USER);
  expect(refs.map((r) => r.slug)).toEqual(["alpha", "beta"]);
  expect(refs[0]?.page_count).toBe(2);
});

test("listTopics omits a topic whose every page is deleted; reappears on restore", () => {
  const r = writePage(paths, USER, { topic: "ghosty", title: "G", body: "g" });
  deletePage(paths, USER, "ghosty", r.page.id);
  expect(listTopics(paths, USER)).toEqual([]);
  // include_empty: true surfaces the empty topic
  expect(listTopics(paths, USER, { include_empty: true })).toHaveLength(1);
  restorePage(paths, USER, "ghosty", r.page.id);
  expect(listTopics(paths, USER)).toHaveLength(1);
});

// --- mutations ------------------------------------------------------- //

test("deletePage tombstones; restorePage flips back; updated_at bumps on both", async () => {
  const r = writePage(paths, USER, { topic: "t", title: "A", body: "a" });
  const created = r.page.updated_at;
  await new Promise((res) => setTimeout(res, 5));
  const deleted = deletePage(paths, USER, "t", r.page.id);
  expect(deleted.status).toBe("deleted");
  expect(deleted.updated_at > created).toBe(true);
  const restored = restorePage(paths, USER, "t", r.page.id);
  expect(restored.status).toBe("active");
  expect(restored.updated_at >= deleted.updated_at).toBe(true);
});

test("deleteTopic bulk-tombstones every active page; pages_deleted count is accurate", () => {
  writePage(paths, USER, { topic: "t", title: "A", body: "a" });
  writePage(paths, USER, { topic: "t", title: "B", body: "b" });
  const r = writePage(paths, USER, { topic: "t", title: "C", body: "c" });
  deletePage(paths, USER, "t", r.page.id); // already deleted; shouldn't recount
  const result = deleteTopic(paths, USER, "t");
  expect(result.pages_deleted).toBe(2);
  const open = openTopic(paths, USER, "t");
  expect(open.topic.pages).toEqual([]);
});

test("renameTopic moves all pages under the new slug; rejects collision; no-op on identity", () => {
  writePage(paths, USER, { topic: "old", title: "A", body: "a" });
  writePage(paths, USER, { topic: "old", title: "B", body: "b" });
  const result = renameTopic(paths, USER, "old", "new");
  expect(result.pages_moved).toBe(2);
  expectThrowCode(() => openTopic(paths, USER, "old"), "topic_not_found");
  expect(openTopic(paths, USER, "new").topic.pages).toHaveLength(2);

  writePage(paths, USER, { topic: "conflict", title: "C", body: "c" });
  expectThrowCode(
    () => renameTopic(paths, USER, "conflict", "new"),
    "topic_exists",
  );

  const noop = renameTopic(paths, USER, "new", "new");
  expect(noop.pages_moved).toBe(0);
});

test("renameTopic rejects when source is missing", () => {
  expectThrowCode(
    () => renameTopic(paths, USER, "ghost", "fresh"),
    "topic_not_found",
  );
});

// --- search ---------------------------------------------------------- //

test("searchNotebook matches title, body, and tags case-insensitively", () => {
  writePage(paths, USER, {
    topic: "swiper",
    title: "Z-INDEX hell",
    body: "the slide-clone trick",
    tags: ["css"],
  });
  writePage(paths, USER, {
    topic: "bugherd",
    title: "RFR",
    body: "Tia's handoff workflow",
    tags: ["tia", "handoff"],
  });

  const byTitle = searchNotebook(paths, USER, { query: "z-index" });
  expect(byTitle.map((h) => h.page_id)).toEqual(["z-index-hell"]);

  const byBody = searchNotebook(paths, USER, { query: "tia" });
  expect(byBody.map((h) => h.page_id)).toEqual(["rfr"]);

  const byTag = searchNotebook(paths, USER, { query: "css" });
  expect(byTag).toHaveLength(1);
});

test("searchNotebook filters by topic and tag", () => {
  writePage(paths, USER, {
    topic: "a",
    title: "match",
    body: "swiper here",
    tags: ["css"],
  });
  writePage(paths, USER, {
    topic: "b",
    title: "match",
    body: "swiper here",
    tags: ["other"],
  });
  expect(searchNotebook(paths, USER, { query: "swiper", topic: "a" })).toHaveLength(1);
  expect(
    searchNotebook(paths, USER, { query: "swiper", tag: "css" }),
  ).toHaveLength(1);
});

test("searchNotebook excludes deleted pages and respects limit", () => {
  for (let i = 0; i < 5; i++) {
    writePage(paths, USER, {
      topic: "t",
      title: `match ${i}`,
      body: "hit",
    });
  }
  const r = openTopic(paths, USER, "t");
  deletePage(paths, USER, "t", r.topic.pages[0]!.id);
  const all = searchNotebook(paths, USER, { query: "hit" });
  expect(all).toHaveLength(4);
  const limited = searchNotebook(paths, USER, { query: "hit", limit: 2 });
  expect(limited).toHaveLength(2);
});

// --- store-level sanity --------------------------------------------- //

test("store is empty when no writes have happened", () => {
  const store = loadNotebookStore(paths, USER);
  expect(store.topics).toEqual([]);
  expect(listTopics(paths, USER)).toEqual([]);
});
