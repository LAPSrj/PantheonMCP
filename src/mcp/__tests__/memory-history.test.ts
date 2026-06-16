import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-mem-history-"));
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

test("recall flags has_history but never returns revisions", async () => {
  await claimAlpha();
  const a = await call("append_memory", { text: "v0", topic: "t", kind: "note" });
  const id = a.payload.id as string;
  await call("update_memory", { id, text: "v1" });

  const recalled = await call("recall_memory", { id });
  expect(recalled.payload.has_history).toBe(true);
  expect(recalled.payload.revisions).toBeUndefined();
});

test("recall(include:['history']) returns first-full + diff timeline", async () => {
  await claimAlpha();
  const a = await call("append_memory", { text: "line a\nline b", topic: "t", kind: "note" });
  const id = a.payload.id as string;
  await call("update_memory", { id, text: "line a\nline B" });

  const h = await call("recall_memory", { id, include: ["history"] });
  const hist = h.payload.history as Record<string, unknown>;
  expect(hist.tip).toBe(1);
  const revs = hist.revisions as Array<Record<string, unknown>>;
  expect(revs.length).toBe(2);
  expect((revs[0]!.full as Record<string, unknown>).text).toBe("line a\nline b");
  expect((revs[1]!.diff as Record<string, unknown>).text).toContain("+ line B");
});

test("recall(include:['history'], revision) returns that revision's full content", async () => {
  await claimAlpha();
  const a = await call("append_memory", { text: "v0", topic: "t", kind: "note" });
  const id = a.payload.id as string;
  await call("update_memory", { id, text: "v1" });

  const r0 = await call("recall_memory", { id, include: ["history"], revision: 0 });
  expect(((r0.payload.history as Record<string, unknown>).content as Record<string, unknown>).text).toBe("v0");
  const r1 = await call("recall_memory", { id, include: ["history"], revision: 1 });
  expect(((r1.payload.history as Record<string, unknown>).content as Record<string, unknown>).text).toBe("v1");
});

test("amend_memory appends server-side and is in history", async () => {
  await claimAlpha();
  const a = await call("append_memory", { text: "first", topic: "t", kind: "note" });
  const id = a.payload.id as string;

  const amended = await call("amend_memory", { id, add: "second" });
  expect(amended.payload.text_chars).toBe("first\n\nsecond".length);

  const recalled = await call("recall_memory", { id });
  expect(recalled.payload.text).toBe("first\n\nsecond");
  expect(recalled.payload.has_history).toBe(true);
});

test("verbose update strips revisions, keeps has_history", async () => {
  await claimAlpha();
  const a = await call("append_memory", { text: "v0", topic: "t", kind: "note" });
  const id = a.payload.id as string;
  const u = await call("update_memory", { id, text: "v1", verbose: true });
  expect(u.payload.text).toBe("v1");
  expect(u.payload.revisions).toBeUndefined();
  expect(u.payload.has_history).toBe(true);
});
