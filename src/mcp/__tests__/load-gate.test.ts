import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { appendEntry } from "../../memory/operations.ts";
import { dispatch } from "../dispatch.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;

function build(gate: boolean): HandlerContext {
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  return createContext({
    paths,
    session: new Session("test-session", {
      kind: "claimed_persona",
      username: "vellumpike",
      resting: false,
    }),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    memory_gate_enabled: gate,
  });
}

function parse(r: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-gate-"));
  ctx = build(true);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("gate disabled (default test/e2e context) never rejects", async () => {
  const open = build(false);
  appendEntry(open.paths, "vellumpike", { text: "x", kind: "rule", topic: "chat" });
  const r = await dispatch("get_memory", {}, open);
  expect(r.isError).toBeFalsy();
});

test("with topics on file, a non-exempt tool is rejected memory_not_loaded", async () => {
  appendEntry(ctx.paths, "vellumpike", { text: "x", kind: "rule", topic: "chat" });
  const r = await dispatch("get_memory", {}, ctx);
  expect(r.isError).toBe(true);
  expect(parse(r).error).toBe("memory_not_loaded");
});

test("list_topics + load_memory + get_instructions are gate-exempt", async () => {
  appendEntry(ctx.paths, "vellumpike", { text: "x", kind: "rule", topic: "chat" });
  for (const tool of ["list_topics", "get_instructions"]) {
    const r = await dispatch(tool, {}, ctx);
    expect(r.isError).toBeFalsy();
  }
});

test("load_memory lifts the gate for subsequent calls", async () => {
  appendEntry(ctx.paths, "vellumpike", { text: "x", kind: "rule", topic: "chat" });
  const before = await dispatch("get_memory", {}, ctx);
  expect(before.isError).toBe(true);

  const load = await dispatch("load_memory", { topics: ["chat"] }, ctx);
  expect(load.isError).toBeFalsy();
  expect(ctx.memory_loaded).toBe(true);

  const after = await dispatch("get_memory", {}, ctx);
  expect(after.isError).toBeFalsy();
});

test("fresh persona (no topics) auto-skips the gate", async () => {
  // No entries → list_topics empty → gate skipped on first non-exempt call.
  const r = await dispatch("get_memory", {}, ctx);
  expect(r.isError).toBeFalsy();
  expect(ctx.memory_loaded).toBe(true);
});

test("list_topics returns clustered topics + counts + due-reminder count", async () => {
  appendEntry(ctx.paths, "vellumpike", { text: "a", kind: "rule", topic: "chat" });
  appendEntry(ctx.paths, "vellumpike", { text: "b", kind: "fact", topic: "chat" });
  appendEntry(ctx.paths, "vellumpike", { text: "c", kind: "rule", topic: "launcher" });
  appendEntry(ctx.paths, "vellumpike", { text: "ping", kind: "reminder", topic: "lifecycle" });
  const r = await dispatch("list_topics", {}, ctx);
  const payload = parse(r);
  const topics = payload.topics as { topic: string; count: number }[];
  const chat = topics.find((t) => t.topic === "chat");
  expect(chat!.count).toBe(2);
  // reminders are excluded from the topic menu but counted as due.
  expect(payload.due_reminders).toBe(1);
  expect(topics.find((t) => t.topic === "lifecycle")).toBeUndefined();
});

test("load_memory returns the render scoped to declared topics", async () => {
  appendEntry(ctx.paths, "vellumpike", { text: "chat body here", kind: "rule", topic: "chat" });
  appendEntry(ctx.paths, "vellumpike", { text: "launcher body", kind: "rule", topic: "launcher" });
  const r = await dispatch("load_memory", { topics: ["chat"] }, ctx);
  const payload = parse(r);
  expect(payload.loaded_topics).toEqual(["chat"]);
  expect(payload.text as string).toContain("chat body here");
  expect(payload.text as string).toContain("launcher(1)"); // not loaded → menu
});

test("get_instructions returns a section by topic + the menu without one", async () => {
  const menu = parse(await dispatch("get_instructions", {}, ctx));
  expect(Array.isArray(menu.topics)).toBe(true);
  const mem = parse(await dispatch("get_instructions", { topic: "memory" }, ctx));
  expect(typeof mem.content).toBe("string");
  const bad = parse(await dispatch("get_instructions", { topic: "nope" }, ctx));
  expect(bad.error).toBe("unknown_topic");
});
