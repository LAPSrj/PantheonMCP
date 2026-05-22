import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { openChatDb } from "../../storage/sqlite.ts";
import { Session, createPersona, transitionClaim } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { ChatRouter } from "../../chat/index.ts";
import {
  pendingRestRequests,
  writeRestRequest,
} from "../../lifecycle/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import { consumeForceLifecycleRequests } from "../handlers/lifecycle.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;
let chatDb: ReturnType<typeof openChatDb>;
const exitCalls: Array<{ delay: number; reason: string }> = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-block-self-exit-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  chatDb = openChatDb(paths.chatDbPath);
  exitCalls.length = 0;
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    summoner_username: "supervisor-1",
    block_self_exit: true,
    chat: new ChatRouter({ paths, db: chatDb }),
    scheduleExit: (delay, reason) => {
      exitCalls.push({ delay, reason });
    },
  });
});

afterEach(() => {
  try {
    chatDb.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(tool: string, args: Record<string, unknown> = {}) {
  const r = await dispatch(tool, args, ctx);
  return {
    ok: !r.isError,
    payload: JSON.parse(r.content[0]!.text) as Record<string, unknown>,
  };
}

function claimPersona(username: string, project = "supervised-project"): void {
  createPersona(ctx.paths, {
    username,
    project,
    cwd: "/tmp/test-cwd",
    platform: "linux",
  });
  transitionClaim(ctx.paths, ctx.session, username);
}

// --- Self-exit gates (block_self_exit=true on ctx) ---

test("rest returns self_exit_blocked when block_self_exit is set", async () => {
  claimPersona("supervised-agent");
  const r = await call("rest", { reason: "wanted to nap" });
  // The handler returns the structured payload as a successful tool
  // result; the dispatch result is OK but the payload carries an
  // error field. (Deliberate — the gate is a domain refusal, not a
  // dispatch error.)
  expect(r.ok).toBe(true);
  expect(r.payload.error).toBe("self_exit_blocked");
  expect(r.payload.message).toContain("supervisor-1");
  expect(r.payload.summoner_username).toBe("supervisor-1");
});

test("exit returns self_exit_blocked when block_self_exit is set; does NOT schedule SIGTERM", async () => {
  const r = await call("exit", {});
  expect(r.ok).toBe(true);
  expect(r.payload.error).toBe("self_exit_blocked");
  expect(exitCalls.length).toBe(0);
});

test("logout returns self_exit_blocked when block_self_exit is set; subscriber stays", async () => {
  await call("login", {
    username: "supervised-agent",
    project: "supervised-project",
    transient: true,
  });
  expect(ctx.chat_agent_id).not.toBeNull();
  const r = await call("logout");
  expect(r.ok).toBe(true);
  expect(r.payload.error).toBe("self_exit_blocked");
  // Subscriber stays — gate prevents the chat-removal escape vector.
  expect(ctx.chat_agent_id).not.toBeNull();
});

test("rest succeeds normally when block_self_exit is unset (default)", async () => {
  // Build a fresh ctx with block_self_exit=false.
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  const session = new Session("free-session");
  const freeCtx = createContext({
    paths,
    session,
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    summoner_username: "supervisor-1",
    // block_self_exit default = false
    chat: new ChatRouter({ paths, db: chatDb }),
  });
  createPersona(paths, {
    username: "free-agent",
    project: "p",
    cwd: "/tmp/test-cwd",
    platform: "linux",
  });
  transitionClaim(paths, session, "free-agent");
  const r = await dispatch("rest", { reason: "natural rest" }, freeCtx);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.error).toBeUndefined();
  expect(payload.ok).toBe(true);
  expect(payload.persona).toBe("free-agent");
});

// --- force_rest / force_exit (caller side) ---

test("force_rest with target_username writes a rest_request row addressed to the target's agent_id", async () => {
  // Caller (this test session) logs in.
  await call("login", {
    username: "caller",
    project: "supervised-project",
    transient: true,
  });
  // Set up a "target" subscriber via a separate router on the same db
  // — different agent, same project.
  const targetRouter = new ChatRouter({ paths: ctx.paths, db: chatDb });
  const target = targetRouter.add({
    username: "target-agent",
    project: "supervised-project",
    transient: false,
  });

  const r = await call("force_rest", {
    target_username: "target-agent",
    reason: "supervisor wrap-up",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.kind).toBe("rest");
  expect(r.payload.target_agent_id).toBe(target.agent_id);
  expect(r.payload.target_username).toBe("target-agent");

  const pending = pendingRestRequests(chatDb, target.agent_id);
  expect(pending.length).toBe(1);
  expect(pending[0]!.kind).toBe("rest");
  expect(pending[0]!.reason).toBe("supervisor wrap-up");
  expect(pending[0]!.from_agent_id).toBe(ctx.chat_agent_id);
});

test("force_exit writes a request row with kind=exit", async () => {
  await call("login", {
    username: "caller",
    project: "supervised-project",
    transient: true,
  });
  const targetRouter = new ChatRouter({ paths: ctx.paths, db: chatDb });
  const target = targetRouter.add({
    username: "target-agent",
    project: "supervised-project",
    transient: false,
  });
  const r = await call("force_exit", { target_agent_id: target.agent_id });
  expect(r.ok).toBe(true);
  expect(r.payload.kind).toBe("exit");
  const pending = pendingRestRequests(chatDb, target.agent_id);
  expect(pending[0]!.kind).toBe("exit");
});

test("force_rest with both target_username and target_agent_id rejects invalid_argument", async () => {
  const r = await call("force_rest", {
    target_username: "x",
    target_agent_id: "y",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_argument");
});

test("force_rest with neither field rejects invalid_argument", async () => {
  const r = await call("force_rest", {});
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_argument");
});

test("force_rest of an offline target rejects target_offline", async () => {
  await call("login", {
    username: "caller",
    project: "supervised-project",
    transient: true,
  });
  const r = await call("force_rest", { target_username: "ghost" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("target_offline");
});

test("force_rest in a different project rejects cross_project_blocked", async () => {
  await call("login", {
    username: "caller",
    project: "project-a",
    transient: true,
  });
  const targetRouter = new ChatRouter({ paths: ctx.paths, db: chatDb });
  targetRouter.add({
    username: "target-in-other",
    project: "project-b",
    transient: false,
  });
  const r = await call("force_rest", { target_username: "target-in-other" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("cross_project_blocked");
});

test("force_rest_any bypasses the same-project guard", async () => {
  await call("login", {
    username: "caller",
    project: "project-a",
    transient: true,
  });
  const targetRouter = new ChatRouter({ paths: ctx.paths, db: chatDb });
  const target = targetRouter.add({
    username: "target-in-other",
    project: "project-b",
    transient: false,
  });
  const r = await call("force_rest_any", { target_username: "target-in-other" });
  expect(r.ok).toBe(true);
  expect(r.payload.target_agent_id).toBe(target.agent_id);
  expect(pendingRestRequests(chatDb, target.agent_id).length).toBe(1);
});

test("force_exit_any bypasses the same-project guard", async () => {
  await call("login", {
    username: "caller",
    project: "project-a",
    transient: true,
  });
  const targetRouter = new ChatRouter({ paths: ctx.paths, db: chatDb });
  const target = targetRouter.add({
    username: "target-in-other",
    project: "project-b",
    transient: false,
  });
  const r = await call("force_exit_any", { target_agent_id: target.agent_id });
  expect(r.ok).toBe(true);
  expect(pendingRestRequests(chatDb, target.agent_id)[0]!.kind).toBe("exit");
});

test("force_rest works on a target that does NOT have block_self_exit set (general primitive)", async () => {
  await call("login", {
    username: "caller",
    project: "supervised-project",
    transient: true,
  });
  // The target subscriber is unconnected to block_self_exit — that
  // gate lives in the target's PROCESS env, not in the request shape.
  const targetRouter = new ChatRouter({ paths: ctx.paths, db: chatDb });
  const target = targetRouter.add({
    username: "non-blocked-agent",
    project: "supervised-project",
    transient: false,
  });
  const r = await call("force_rest", { target_username: "non-blocked-agent" });
  expect(r.ok).toBe(true);
  expect(pendingRestRequests(chatDb, target.agent_id).length).toBe(1);
});

// --- Consume from prune tick (target side) ---

test("consume applies force_rest: transitions session to resting + stamps persona + schedules SIGTERM", async () => {
  // Wire the target session — claim a persona and log into chat with
  // its own agent_id.
  claimPersona("supervised-agent");
  await call("login", {
    username: "supervised-agent",
    project: "supervised-project",
    transient: false,
  });
  const myAgentId = ctx.chat_agent_id!;

  // Drop a force_rest row addressed to me.
  writeRestRequest(chatDb, {
    target_agent_id: myAgentId,
    from_agent_id: "supervisor-agent-id",
    kind: "rest",
    reason: "audit complete",
  });

  // Sanity: pending before consume.
  expect(pendingRestRequests(chatDb, myAgentId).length).toBe(1);

  const result = consumeForceLifecycleRequests(ctx);
  expect(result.consumed).toBe(1);
  expect(result.rested).toBe(true);
  // force_rest now also schedules SIGTERM (mirroring force_exit's
  // teardown) — pre-fix the OS process leaked indefinitely. The
  // "rest" semantics survive via stampRested below; the process
  // termination is what makes force_rest actually clean up.
  expect(result.exiting).toBe(true);

  // Pending now zero — consume DELETEs the row.
  expect(pendingRestRequests(chatDb, myAgentId).length).toBe(0);

  // Session transitioned to resting; persona file stamped.
  const { readPersona } = await import("../../identity/index.ts");
  const persona = readPersona(ctx.paths, "supervised-agent");
  expect(persona?.last_rested_at).not.toBeNull();
  expect(persona?.rest_reason).toContain("force_rest");
  expect(persona?.rest_reason).toContain("audit complete");

  // SIGTERM scheduled. This is what closes the leaked-process bug —
  // the asymmetry from force_exit is only the stampRested above
  // (durable resume signal).
  expect(exitCalls.length).toBe(1);
  expect(exitCalls[0]!.delay).toBe(2);
  expect(exitCalls[0]!.reason).toBe("force_rest");
});

test("consume applies force_exit: schedules SIGTERM via ctx.scheduleExit", async () => {
  claimPersona("supervised-agent");
  await call("login", {
    username: "supervised-agent",
    project: "supervised-project",
    transient: false,
  });
  const myAgentId = ctx.chat_agent_id!;

  writeRestRequest(chatDb, {
    target_agent_id: myAgentId,
    from_agent_id: "supervisor-agent-id",
    kind: "exit",
    reason: "shutdown",
  });

  const result = consumeForceLifecycleRequests(ctx);
  expect(result.consumed).toBe(1);
  expect(result.exiting).toBe(true);

  // scheduleExit was called with delay=2 (the force-exit default) and
  // a force_exit reason.
  expect(exitCalls.length).toBe(1);
  expect(exitCalls[0]!.delay).toBe(2);
  expect(exitCalls[0]!.reason).toBe("force_exit");
});

test("consume bypasses the block_self_exit gate (force-* IS the override)", async () => {
  // ctx.block_self_exit is true (set in beforeEach).
  claimPersona("supervised-agent");
  await call("login", {
    username: "supervised-agent",
    project: "supervised-project",
    transient: false,
  });
  const myAgentId = ctx.chat_agent_id!;
  writeRestRequest(chatDb, {
    target_agent_id: myAgentId,
    from_agent_id: null,
    kind: "rest",
    reason: "external",
  });

  const result = consumeForceLifecycleRequests(ctx);
  expect(result.rested).toBe(true);
  // Persona stamped despite block_self_exit being on.
  const { readPersona } = await import("../../identity/index.ts");
  const persona = readPersona(ctx.paths, "supervised-agent");
  expect(persona?.last_rested_at).not.toBeNull();
});

test("consume is a no-op when no requests pending", async () => {
  claimPersona("supervised-agent");
  await call("login", {
    username: "supervised-agent",
    project: "supervised-project",
    transient: false,
  });
  const result = consumeForceLifecycleRequests(ctx);
  expect(result.consumed).toBe(0);
  expect(result.rested).toBe(false);
  expect(result.exiting).toBe(false);
  expect(exitCalls.length).toBe(0);
});

test("consume is a no-op when not logged in to chat", async () => {
  claimPersona("supervised-agent");
  // No login call — chat_agent_id is null.
  expect(ctx.chat_agent_id).toBeNull();
  // A request addressed to some other agent_id sits there untouched.
  writeRestRequest(chatDb, {
    target_agent_id: "some-other-agent-id",
    from_agent_id: null,
    kind: "rest",
  });
  const result = consumeForceLifecycleRequests(ctx);
  expect(result.consumed).toBe(0);
  expect(pendingRestRequests(chatDb, "some-other-agent-id").length).toBe(1);
});

test("consume on first kind=exit short-circuits subsequent rows", async () => {
  claimPersona("supervised-agent");
  await call("login", {
    username: "supervised-agent",
    project: "supervised-project",
    transient: false,
  });
  const myAgentId = ctx.chat_agent_id!;
  writeRestRequest(chatDb, {
    target_agent_id: myAgentId,
    from_agent_id: null,
    kind: "exit",
    now: 1_000,
  });
  // Second row: should not run further actions after the exit.
  writeRestRequest(chatDb, {
    target_agent_id: myAgentId,
    from_agent_id: null,
    kind: "rest",
    now: 2_000,
  });
  const result = consumeForceLifecycleRequests(ctx);
  // Both rows are claimed by consumePendingRestRequests, but the
  // applyForceExit branch breaks out so applyForceRest never runs.
  expect(result.exiting).toBe(true);
  expect(exitCalls.length).toBe(1);
  // The rested flag stays false because we broke out before applying it.
  expect(result.rested).toBe(false);
});
