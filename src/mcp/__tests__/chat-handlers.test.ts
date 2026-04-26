import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { ChatRouter } from "../../chat/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-chat-handlers-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    chat: new ChatRouter({ paths }),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(tool: string, args: Record<string, unknown> = {}) {
  const r = await dispatch(tool, args, ctx);
  return {
    ok: !r.isError,
    payload: JSON.parse(r.content[0]!.text) as Record<string, unknown>,
  };
}

// --- login / logout ---

test("login as a guest succeeds and sets chat_agent_id on the context", async () => {
  const r = await call("login", {
    username: "leandro",
    project: "ops",
    transient: true,
    status: "exploring",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.transient).toBe(true);
  expect(r.payload.username).toBe("leandro");
  expect(typeof r.payload.agent_id).toBe("string");
  expect(ctx.chat_agent_id).toBe(r.payload.agent_id as string);
});

test("login + logout clears chat_agent_id", async () => {
  await call("login", { username: "leandro", project: "ops", transient: true });
  expect(ctx.chat_agent_id).not.toBeNull();
  const r = await call("logout");
  expect(r.ok).toBe(true);
  expect(ctx.chat_agent_id).toBeNull();
});

test("login collision: returns enriched error with options + suggested_suffix; does NOT auto-evict", async () => {
  // First login takes the handle.
  const first = await call("login", {
    username: "swoopfinch",
    project: "ops",
    transient: true,
  });
  expect(first.ok).toBe(true);
  // Second session tries the same handle; chat router rejects.
  // Build a second session for clarity.
  const sess2 = new Session("test-session-2");
  const ctx2 = createContext({
    paths: ctx.paths,
    session: sess2,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  const r = await dispatch(
    "login",
    { username: "swoopfinch", project: "ops", transient: true },
    ctx2,
  );
  expect(r.isError).toBe(true);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.error).toBe("username_taken");
  // Three remediation options spelled out.
  const options = payload.options as string[];
  expect(options).toBeInstanceOf(Array);
  expect(options).toHaveLength(3);
  expect(options[0]).toContain("Close the OTHER session");
  expect(options[1]).toContain("Close THIS pane");
  expect(options[2]).toContain("--chat-username-suffix");
  // suggested_suffix is the next-free `<base><N>` (typically 2).
  expect(payload.suggested_suffix).toBe("swoopfinch2");
  // Critical: the OTHER session is NOT evicted.
  expect(payload.do_not_auto_logout).toContain("DO NOT call `logout`");
  // The first agent stays subscribed.
  expect(ctx.chat?.getByUsername("swoopfinch")).not.toBeNull();
});

test("login collision: suggested_suffix walks past taken numbers", async () => {
  // Take swoopfinch + swoopfinch2 + swoopfinch3 first.
  for (const u of ["swoopfinch", "swoopfinch2", "swoopfinch3"]) {
    const sess = new Session(`s-${u}`);
    const c = createContext({
      paths: ctx.paths,
      session: sess,
      watchdog: ctx.watchdog,
      parent_pid: ctx.parent_pid,
      platform: ctx.platform,
      chat: ctx.chat,
    });
    await dispatch("login", { username: u, project: "ops", transient: true }, c);
  }
  // Now try swoopfinch from yet another session — suggested should be 4.
  const sess4 = new Session("test-session-4");
  const ctx4 = createContext({
    paths: ctx.paths,
    session: sess4,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  const r = await dispatch(
    "login",
    { username: "swoopfinch", project: "ops", transient: true },
    ctx4,
  );
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.suggested_suffix).toBe("swoopfinch4");
});

test("login with promote flips guest → claimed_persona via promoteInPlace", async () => {
  const r = await call("login", {
    username: "leandro",
    project: "ops",
    transient: true,
    promote: {
      project: "ops",
      description: "ops human",
      expertise: ["bash"],
      owns: ["/ops"],
    },
  });
  expect(r.ok).toBe(true);
  expect(r.payload.promoted).toBe(true);
  // The subscriber is created as a guest; promote then flips it.
  // The response surfaces `promoted: true` rather than re-asserting
  // the initial transient flag (which has already been overwritten
  // by the in-place flip).
  expect(r.payload.username).toBe("leandro");
  // Subscriber state should now be non-transient.
  expect(ctx.chat?.getByUsername("leandro")?.transient).toBe(false);
});

// --- send_message + scopes ---

test("send_message persists + delivers to project peers", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // Add a peer directly on the router so we can verify delivery.
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const sent = await call("send_message", { text: "hello team" });
  expect(sent.ok).toBe(true);

  const taken = ctx.chat!.takeMessages(peer.agent_id);
  expect(taken.messages.map((m) => m.text)).toContain("hello team");
});

test("send_message with scope='dm' requires a target", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", { text: "psst", scope: "dm" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("missing_target");
});

// --- ask / answer ---

test("ask resolves when the target answers", async () => {
  await call("login", { username: "asker", project: "p", transient: false });
  const target = ctx.chat!.add({ username: "target", project: "p", transient: false });
  // Fire the ask; it returns a promise we await separately to allow
  // the answer to land in between.
  const askPromise = dispatch(
    "ask",
    { target: "target", text: "what time?", timeout_ms: 5000 },
    ctx,
  );
  // Find the correlation id from the message dispatched to target.
  const incoming = ctx.chat!.takeMessages(target.agent_id).messages;
  expect(incoming).toHaveLength(1);
  const askId = incoming[0]!.ask_id!;
  ctx.chat!.answer({ from_agent_id: target.agent_id, correlation_id: askId, text: "noon" });
  const result = await askPromise;
  const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  expect(payload.text).toBe("noon");
  expect(payload.from).toBe("target");
});

test("ask returns timeout when the target disconnects", async () => {
  await call("login", { username: "asker", project: "p", transient: false });
  const target = ctx.chat!.add({ username: "target", project: "p", transient: false });
  const askPromise = dispatch(
    "ask",
    { target: "target", text: "?", timeout_ms: 5000 },
    ctx,
  );
  ctx.chat!.remove(target.agent_id);
  const result = await askPromise;
  const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  expect(payload.status).toBe("timeout");
});

// --- list_agents + find_role ---

test("list_agents lists connected subscribers", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("list_agents");
  expect(r.payload.count).toBe(2);
});

test("find_role joins persona registry with online status", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const { createPersona } = await import("../../identity/index.ts");
  createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "X",
    cwd: "/repos/chat-mcp",
    platform: "linux",
    expertise: ["chat-routing"],
    owns: ["/repos/chat-mcp"],
  });
  const r = await call("find_role", { expertise: "chat-routing" });
  expect(r.ok).toBe(true);
  const personas = r.payload.personas as Array<{ username: string; online: boolean }>;
  expect(personas.map((p) => p.username)).toContain("moth-whistle");
  // moth-whistle is registered but not connected — online should be false.
  expect(personas.find((p) => p.username === "moth-whistle")?.online).toBe(false);
});

// --- check_messages + set_mode + update_status ---

test("check_messages pulls pending messages and advances cursor", async () => {
  const me = await call("login", { username: "alpha", project: "X", transient: false });
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  ctx.chat!.addMessage({ from_agent_id: peer.agent_id, scope: "project", text: "hi alpha" });

  const r = await call("check_messages");
  // Includes the explicit "hi alpha" plus the system `join` event for
  // the peer that was added after login.
  expect((r.payload.count as number)).toBeGreaterThanOrEqual(1);
  const messages = r.payload.messages as Array<{ text: string }>;
  expect(messages.some((m) => m.text === "hi alpha")).toBe(true);
  // Second call returns empty (cursor advanced).
  const r2 = await call("check_messages");
  expect(r2.payload.count).toBe(0);
  // (suppress unused linter)
  void me;
});

test("set_mode flips delivery mode", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("set_mode", { mode: "quiet" });
  expect(r.ok).toBe(true);
  expect(r.payload.mode).toBe("quiet");
  expect(ctx.chat?.getByAgentId(ctx.chat_agent_id!)?.mode).toBe("quiet");
});

test("update_status updates status + emits status_update system event", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  await call("update_status", { status: "deep work" });
  const taken = ctx.chat!.takeMessages(peer.agent_id);
  expect(taken.messages.find((m) => m.system_kind === "status_update")?.text).toContain("deep work");
});
