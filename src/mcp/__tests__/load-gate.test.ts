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

test("a gate rejection carries a JIT see_instructions pointer (boot)", async () => {
  appendEntry(ctx.paths, "vellumpike", { text: "x", kind: "rule", topic: "chat" });
  const r = await dispatch("get_memory", {}, ctx);
  const payload = parse(r) as { error: string; see_instructions?: { topic: string } };
  expect(payload.error).toBe("memory_not_loaded");
  expect(payload.see_instructions!.topic).toBe("boot");
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

test("get_instructions: memory topic carries the concision norm + rationale", async () => {
  const mem = parse(await dispatch("get_instructions", { topic: "memory" }, ctx));
  const content = mem.content as string;
  expect(content).toContain("CONCISELY");
  // The incentive framing — shared budget + self-eviction — must be stated,
  // not just a bare "be brief".
  expect(content).toContain("budget");
  expect(content).toContain("self-evict");
});

test("get_instructions: chat topic carries the relay-cap concision norm", async () => {
  const chat = parse(await dispatch("get_instructions", { topic: "chat" }, ctx));
  const content = chat.content as string;
  expect(content).toContain("SHORT");
  expect(content).toContain("relay");
  expect(content).toContain("get_message");
});

// --- P6 decay via the handler surface ---

test("load_memory starts the session ordinal; appends stamp session_seq", async () => {
  await dispatch("load_memory", { topics: ["chat"] }, ctx);
  expect(ctx.session_seq).toBe(1);
  const created = parse(await dispatch("append_memory", { text: "x", kind: "rule", topic: "chat", verbose: true }, ctx));
  expect(created.session_seq).toBe(1);
});

test("summary_max240 is accepted as an alias for summary (stored as summary)", async () => {
  await dispatch("load_memory", { topics: ["git"] }, ctx);
  const created = parse(
    await dispatch(
      "append_memory",
      { text: "body", summary_max240: "when X, do Y", kind: "rule", topic: "git", verbose: true },
      ctx,
    ),
  );
  expect(created.summary).toBe("when X, do Y");
});

test("core is no longer an accepted write input (v2 §16 hard-cut → invalid_args)", async () => {
  await dispatch("load_memory", { topics: ["git"] }, ctx);
  const r = await dispatch("append_memory", { text: "x", kind: "rule", topic: "git", core: true }, ctx);
  expect(r.isError).toBe(true);
  expect(parse(r).error).toBe("invalid_args");
});

test("append with supersedes forgets the superseded target", async () => {
  await dispatch("load_memory", { topics: ["git"] }, ctx);
  const old = parse(await dispatch("append_memory", { text: "old rule", kind: "rule", topic: "git" }, ctx));
  const res = parse(
    await dispatch(
      "append_memory",
      { text: "new rule", kind: "rule", topic: "git", supersedes: old.id as string },
      ctx,
    ),
  );
  expect(res.superseded).toBe(old.id as string);
  // The superseded entry is now forgotten (hidden unless include_forgotten).
  const visible = parse(await dispatch("get_memory", {}, ctx));
  expect(visible.text as string).not.toContain("old rule");
});

test("load_memory delivers a matching handoff then fades it after exact-focus session", async () => {
  // Seed a handoff under 'memory' directly on disk.
  appendEntry(ctx.paths, "vellumpike", { text: "resume here", kind: "handoff", topic: "memory" });
  const load = parse(await dispatch("load_memory", { topic: "memory" }, ctx));
  // Delivered in THIS session's render.
  expect(load.text as string).toContain("DELIVERED HANDOFFS");
  expect(load.text as string).toContain("resume here");
  // ...and consumed for the future (A == {H} → autofade).
  const after = parse(await dispatch("get_memory", {}, ctx));
  expect(after.text as string).not.toContain("DELIVERED HANDOFFS");
});
