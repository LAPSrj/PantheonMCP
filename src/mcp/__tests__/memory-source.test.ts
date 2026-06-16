import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openChatDb, resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { persistMessage } from "../../chat/persistence.ts";
import { appendEntry, updateEntry, getEntry } from "../../memory/operations.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-mem-source-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(tool: string, args: Record<string, unknown> = {}): Promise<{
  ok: boolean;
  payload: Record<string, unknown>;
}> {
  const r = await dispatch(tool, args, ctx);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  return { ok: !r.isError, payload };
}

async function claimAlpha(): Promise<void> {
  await call("register", {
    username: "alpha",
    cwd: "/work/alpha",
    project: "X",
    description: "tester",
    expertise: ["x"],
    owns: ["/work/alpha"],
  });
  await call("claim", { username: "alpha" });
}

function seedChatMessage(id: string, text: string): void {
  const db = openChatDb(ctx.paths.chatDbPath);
  persistMessage(db, {
    id,
    seq: 0,
    ts: 1_700_000_000_000,
    scope: "project",
    project: "X",
    from_agent_id: "agent-leandro",
    from_username_inline: "leandro",
    text,
    mentions: [],
    from_project: "X",
  } as never);
}

// --- data layer: storage of sources ----------------------------------- //

test("appendEntry persists sources; updateEntry replaces and clears them", () => {
  const created = appendEntry(ctx.paths, "alpha", {
    text: "rule body",
    summary: "a rule",
    sources: [{ message_id: "m1", text: "the original", resolved: true }],
  });
  expect(created.sources).toEqual([
    { message_id: "m1", text: "the original", resolved: true },
  ]);

  // Replace.
  const replaced = updateEntry(ctx.paths, "alpha", created.id, {
    sources: [{ quote: "verbatim", resolved: false }],
  });
  expect(replaced.sources).toEqual([{ quote: "verbatim", resolved: false }]);

  // Clear with null.
  const cleared = updateEntry(ctx.paths, "alpha", created.id, { sources: null });
  expect(cleared.sources).toBeUndefined();
});

// --- write resolution -------------------------------------------------- //

test("append_memory snapshots a chat message_id at write", async () => {
  await claimAlpha();
  seedChatMessage("msg-123", "WE ARE NOT IN A HURRY HERE");

  const { ok, payload } = await call("append_memory", {
    text: "Leandro wants things done right, not fast.",
    summary_max240: "when pacing work, remember: right not fast",
    kind: "rule",
    topic: "conventions",
    sources: [{ message_id: "msg-123", label: "Leandro" }],
  });
  expect(ok).toBe(true);
  expect(payload.sources).toEqual({ count: 1, resolved: 1 });

  // Snapshot landed on the stored entry.
  const stored = getEntry(ctx.paths, "alpha", payload.id as string)!;
  expect(stored.sources).toHaveLength(1);
  expect(stored.sources![0]).toMatchObject({
    message_id: "msg-123",
    text: "WE ARE NOT IN A HURRY HERE",
    author: "leandro",
    resolved: true,
    label: "Leandro",
  });
});

test("append_memory keeps an unresolvable message_id but marks resolved:false", async () => {
  await claimAlpha();
  const { ok, payload } = await call("append_memory", {
    text: "something",
    summary_max240: "a note with a bad source ref",
    kind: "note",
    topic: "misc",
    sources: [{ message_id: "does-not-exist" }],
  });
  expect(ok).toBe(true);
  expect(payload.sources).toEqual({ count: 1, resolved: 0 });
  const stored = getEntry(ctx.paths, "alpha", payload.id as string)!;
  expect(stored.sources![0]).toMatchObject({ message_id: "does-not-exist", resolved: false });
  expect(stored.sources![0]!.text).toBeUndefined();
});

// --- read projection --------------------------------------------------- //

test("recall_memory flags has_source and never returns the sources array", async () => {
  await claimAlpha();
  seedChatMessage("msg-9", "the source text");
  const appended = await call("append_memory", {
    text: "body",
    summary_max240: "an entry with provenance",
    kind: "fact",
    topic: "t",
    sources: [{ message_id: "msg-9" }],
  });

  const { payload } = await call("recall_memory", { id: appended.payload.id });
  expect(payload.has_source).toBe(true);
  expect(payload.sources).toBeUndefined();
});

test("recall_memory reports has_source:false for an entry with no provenance", async () => {
  await claimAlpha();
  const appended = await call("append_memory", {
    text: "body",
    summary_max240: "no provenance here",
    kind: "note",
    topic: "t",
  });
  const { payload } = await call("recall_memory", { id: appended.payload.id });
  expect(payload.has_source).toBe(false);
});

// --- recall_memory(include: ['source']) -------------------------------- //

test("recall(include:['source']) returns the snapshot + coordinates; empty array when none", async () => {
  await claimAlpha();
  seedChatMessage("msg-7", "quoted text");
  const withSrc = await call("append_memory", {
    text: "body",
    summary_max240: "entry with source",
    kind: "rule",
    topic: "conventions",
    sources: [{ message_id: "msg-7", label: "tag" }],
  });
  const got = await call("recall_memory", { id: withSrc.payload.id, include: ["source"] });
  expect(got.ok).toBe(true);
  expect(got.payload.sources).toHaveLength(1);
  expect((got.payload.sources as unknown[])[0]).toMatchObject({
    message_id: "msg-7",
    text: "quoted text",
    resolved: true,
    label: "tag",
  });

  const noSrc = await call("append_memory", {
    text: "body2",
    summary_max240: "entry without source",
    kind: "note",
    topic: "t",
  });
  const gotEmpty = await call("recall_memory", { id: noSrc.payload.id, include: ["source"] });
  expect(gotEmpty.payload.sources).toEqual([]);
});

test("update_memory can clear sources via null", async () => {
  await claimAlpha();
  seedChatMessage("msg-1", "x");
  const appended = await call("append_memory", {
    text: "body",
    summary_max240: "clearable provenance",
    kind: "note",
    topic: "t",
    sources: [{ message_id: "msg-1" }],
  });
  await call("update_memory", { id: appended.payload.id, sources: null });
  const got = await call("recall_memory", { id: appended.payload.id, include: ["source"] });
  expect(got.payload.sources).toEqual([]);
});
