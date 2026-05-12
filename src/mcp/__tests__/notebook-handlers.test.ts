import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session, createPersona } from "../../identity/index.ts";
import { Watchdog } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let outDir: string;
let ctx: HandlerContext;

class FakeScheduler {
  private nowMs = 0;
  private nextId = 1;
  private pending = new Map<number, { fireAt: number; fn: () => void }>();
  now() {
    return this.nowMs;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.pending.set(id, { fireAt: this.nowMs + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.pending.delete(handle as number);
  }
  advance(ms: number) {
    this.nowMs += ms;
    for (const [id, t] of [...this.pending.entries()]) {
      if (t.fireAt <= this.nowMs) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-nb-handlers-"));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-nb-out-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(new FakeScheduler() as never),
    parent_pid: 99999,
    platform: "linux",
    scheduleExit: () => {},
  });
  // Register + claim a persona so write handlers can find one.
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
  ctx.session._setState({
    kind: "claimed_persona",
    username: "vellumpike",
    resting: false,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

async function call(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{
  ok: boolean;
  payload: Record<string, unknown>;
}> {
  const r = await dispatch(tool, args, ctx);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  return { ok: !r.isError, payload };
}

// --- write + read round-trip ----------------------------------------- //

test("notebook_write_page → notebook_open round-trips and stamps author_username", async () => {
  const w = await call("notebook_write_page", {
    topic: "swiper-zindex",
    title: "Clone collisions",
    body: "pin --swiper-z-index: 1 on clones",
    tags: ["css"],
  });
  expect(w.ok).toBe(true);
  expect((w.payload.page as Record<string, unknown>).author_username).toBe(
    "vellumpike",
  );

  const open = await call("notebook_open", { topic: "swiper-zindex" });
  expect(open.ok).toBe(true);
  const topic = open.payload.topic as { pages: unknown[] };
  expect(topic.pages).toHaveLength(1);
});

test("notebook_list_topics returns TOC sorted by last_touched desc", async () => {
  await call("notebook_write_page", { topic: "alpha", title: "A", body: "a" });
  await call("notebook_write_page", { topic: "beta", title: "B", body: "b" });
  await call("notebook_write_page", { topic: "alpha", title: "A2", body: "a2" });

  const r = await call("notebook_list_topics", {});
  expect(r.ok).toBe(true);
  const topics = r.payload.topics as Array<{ slug: string }>;
  expect(topics.map((t) => t.slug)).toEqual(["alpha", "beta"]);
});

test("notebook_search returns hits scoped by topic", async () => {
  await call("notebook_write_page", {
    topic: "a",
    title: "match",
    body: "swiper here",
  });
  await call("notebook_write_page", {
    topic: "b",
    title: "match",
    body: "swiper here",
  });
  const r = await call("notebook_search", { query: "swiper", topic: "a" });
  expect(r.ok).toBe(true);
  expect(r.payload.count).toBe(1);
});

// --- delete / restore / rename --------------------------------------- //

test("notebook_delete_page tombstones; restore brings it back", async () => {
  const w = await call("notebook_write_page", {
    topic: "t",
    title: "A",
    body: "body",
  });
  const pageId = (w.payload.page as { id: string }).id;
  const d = await call("notebook_delete_page", { topic: "t", page_id: pageId });
  expect((d.payload.page as { status: string }).status).toBe("deleted");
  const list = await call("notebook_list_topics", {});
  expect((list.payload.topics as unknown[]).length).toBe(0);

  await call("notebook_restore_page", { topic: "t", page_id: pageId });
  const listAfter = await call("notebook_list_topics", {});
  expect((listAfter.payload.topics as unknown[]).length).toBe(1);
});

test("notebook_rename_topic moves all pages; collision rejects", async () => {
  await call("notebook_write_page", { topic: "old", title: "A", body: "a" });
  await call("notebook_write_page", { topic: "old", title: "B", body: "b" });
  await call("notebook_write_page", { topic: "taken", title: "C", body: "c" });

  const ok = await call("notebook_rename_topic", { from: "old", to: "fresh" });
  expect(ok.ok).toBe(true);

  const conflict = await call("notebook_rename_topic", {
    from: "fresh",
    to: "taken",
  });
  expect(conflict.ok).toBe(false);
  expect(conflict.payload.error).toBe("topic_exists");
});

// --- cross-persona reads --------------------------------------------- //

test("notebook_open_any reads another persona's notebook", async () => {
  // Create a second persona with a notebook entry directly.
  const peer = "semaphoremole";
  createPersona(ctx.paths, {
    username: peer,
    project: "pantheon",
    cwd: "/peer",
    platform: "linux",
  });
  const { writePage } = await import("../../notebook/index.ts");
  writePage(ctx.paths, peer, {
    topic: "peer-topic",
    title: "P",
    body: "peer body",
  });

  const r = await call("notebook_open_any", {
    username: peer,
    topic: "peer-topic",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.username).toBe(peer);
});

test("notebook_search_any with scope: 'all' unions every persona", async () => {
  await call("notebook_write_page", {
    topic: "mine",
    title: "mine",
    body: "needle one",
  });
  const peer = "semaphoremole";
  createPersona(ctx.paths, {
    username: peer,
    project: "pantheon",
    cwd: "/peer",
    platform: "linux",
  });
  const { writePage } = await import("../../notebook/index.ts");
  writePage(ctx.paths, peer, {
    topic: "peers",
    title: "peer",
    body: "needle two",
  });

  const r = await call("notebook_search_any", {
    query: "needle",
    scope: "all",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.count).toBe(2);
  const hits = r.payload.hits as Array<{ username: string }>;
  const owners = new Set(hits.map((h) => h.username));
  expect(owners.size).toBe(2);
});

// --- export ---------------------------------------------------------- //

test("notebook_export writes the markdown file; refuses overwrite by default", async () => {
  await call("notebook_write_page", { topic: "t", title: "A", body: "a" });
  const outPath = path.join(outDir, "out.md");
  const r1 = await call("notebook_export", { output_path: outPath });
  expect(r1.ok).toBe(true);
  expect(fs.existsSync(outPath)).toBe(true);

  const r2 = await call("notebook_export", { output_path: outPath });
  expect(r2.ok).toBe(false);
  expect(r2.payload.error).toBe("file_exists");

  const r3 = await call("notebook_export", {
    output_path: outPath,
    overwrite: true,
  });
  expect(r3.ok).toBe(true);
});

// --- write rejection paths ------------------------------------------- //

test("write without claimed persona returns no_persona", async () => {
  ctx.session._setState({ kind: "unclaimed" });
  const r = await call("notebook_write_page", {
    topic: "x",
    title: "y",
    body: "z",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("no_persona");
});

test("dispatcher rejects unknown fields", async () => {
  const r = await call("notebook_write_page", {
    topic: "x",
    title: "y",
    body: "z",
    bogus: 1,
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("dispatcher rejects bad topic slug", async () => {
  const r = await call("notebook_write_page", {
    topic: "Bad Slug",
    title: "y",
    body: "z",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_topic_slug");
});

// --- project notebook surface ---------------------------------------- //

test("project_notebook write/open requires chat scope; _any variant works without", async () => {
  // No chat router attached → bare variant fails project_scope check.
  const bare = await call("project_notebook_write_page", {
    topic: "t",
    title: "A",
    body: "a",
  });
  expect(bare.ok).toBe(false);
  expect(bare.payload.error).toBe("no_project_scope");

  // _any takes explicit project — succeeds.
  const explicit = await call("project_notebook_write_page_any", {
    project: "pantheon",
    topic: "t",
    title: "A",
    body: "a",
  });
  expect(explicit.ok).toBe(true);
  expect(
    (explicit.payload.page as Record<string, unknown>).author_username,
  ).toBe("vellumpike");

  const open = await call("project_notebook_open_any", {
    project: "pantheon",
    topic: "t",
  });
  expect(open.ok).toBe(true);
});

test("project_notebook_export_any writes markdown for the project", async () => {
  await call("project_notebook_write_page_any", {
    project: "pantheon",
    topic: "shared",
    title: "S",
    body: "shared body",
  });
  const outPath = path.join(outDir, "project.md");
  const r = await call("project_notebook_export_any", {
    project: "pantheon",
    output_path: outPath,
  });
  expect(r.ok).toBe(true);
  const text = fs.readFileSync(outPath, "utf8");
  expect(text).toContain("shared body");
});
