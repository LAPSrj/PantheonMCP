import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { ChatRouter, listActive } from "../../../chat/index.ts";
import { Session, createPersona } from "../../../identity/index.ts";
import { openChatDb, resolvePaths } from "../../../storage/index.ts";
import { Watchdog, realScheduler } from "../../../watchdog/index.ts";
import {
  type SpawnExecutor,
  type SpawnedProcess,
} from "../../../launcher/index.ts";
import { createContext } from "../../context.ts";
import { dispatch } from "../../dispatch.ts";
import type { HandlerContext } from "../../types.ts";
import { writeRestRequest } from "../../../lifecycle/index.ts";
import { consumeForceLifecycleRequests } from "../lifecycle.ts";

/** Commit 2 of the canonical-handle reclaim fix: the `remanifest`
 * handler self-evicts from chat once `spawnPersona` confirms a valid
 * spawn_pid. This drops OLD's presence row from SQLite immediately
 * so NEW's first login sees the canonical handle free — no
 * auto-suffix, no 60-90s reclaim window.
 *
 * These tests drive the handler against a mock spawn executor so the
 * spawn_pid is deterministic (success path) or null (failure path),
 * verifying the gating on each branch. */

let tmpDir: string;
let ctx: HandlerContext;
let db: ReturnType<typeof openChatDb>;
let mockPid: number | null;
let exitCalls: { delay_seconds: number; reason: string }[];

function makeMockExecutor(): SpawnExecutor {
  return {
    spawn(_command, _args, _options): SpawnedProcess {
      return {
        pid: mockPid as number,
        stderr: Readable.from([]) as unknown as NodeJS.ReadableStream,
        unref() {},
      };
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-remanifest-"));
  mockPid = 23456;
  exitCalls = [];
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  ctx = createContext({
    paths,
    session: new Session("remanifest-old"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 88888,
    platform: "linux",
    spawn_executor: makeMockExecutor(),
    stderr_probe_ms: 5,
    spawn_env: {} as NodeJS.ProcessEnv,
    chat: router,
    scheduleExit: (delay_seconds, reason) => {
      exitCalls.push({ delay_seconds, reason });
    },
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // best-effort
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

function makePersona() {
  return createPersona(ctx.paths, {
    username: "wraith",
    project: "pantheon",
    cwd: "/work/wraith",
    platform: "linux",
    description: "investigator",
    expertise: ["chat"],
    owns: ["/work/wraith"],
    launch_command: "claude",
    launch_args: ["--print"],
  });
}

test("remanifest: self-evicts OLD's chat presence after a successful spawn", async () => {
  makePersona();
  // OLD claims the persona + logs into chat as canonical.
  await call("claim", { username: "wraith" });
  const login = await call("login", {
    username: "wraith",
    project: "pantheon",
    transient: false,
  });
  expect(login.ok).toBe(true);
  const oldAgentId = login.payload.agent_id as string;

  // Pre-condition: OLD's presence row is live.
  expect(
    listActive(db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === oldAgentId,
    ),
  ).toBe(true);

  const r = await call("remanifest", {
    handoff: "context got unwieldy; new incarnation taking over",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.remanifested).toBe("wraith");
  expect(r.payload.self_evicted).toBe(true);
  expect((r.payload.new_session as Record<string, unknown>).spawn_pid).toBe(23456);

  // Post-condition: OLD's presence row is gone — NEW's first login
  // will see canonical free.
  expect(
    listActive(db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === oldAgentId,
    ),
  ).toBe(false);
  // ctx.chat_agent_id is KEPT (not nulled) — the OLD process exits
  // via the rest_requests pipeline; NEW writes a row addressed to
  // this agent_id and OLD's prune-tick consumer reads
  // ctx.chat_agent_id to claim it. Heartbeat/send/status all guard
  // on `subscribers.has`, so the dangling id is harmless.
  expect(ctx.chat_agent_id).toBe(oldAgentId);
});

test("remanifest: skips self-eviction when spawn fails (no spawn_pid)", async () => {
  makePersona();
  await call("claim", { username: "wraith" });
  const login = await call("login", {
    username: "wraith",
    project: "pantheon",
    transient: false,
  });
  const oldAgentId = login.payload.agent_id as string;

  // Simulate spawn failure (pid 0 / null branch in mock executor).
  // Cast through unknown so the test seam reads as `null` even though
  // SpawnedProcess.pid is typed as number. We use 0 instead — falsy
  // satisfies the gating check (`if (result.spawn_pid && ...)`).
  mockPid = 0;

  const r = await call("remanifest", {
    handoff: "spawn-fail simulation",
  });
  expect(r.ok).toBe(true);
  // self_evicted MUST be false on the failure path — agent stays
  // visible in chat so the user doesn't lose chat access silently
  // for a spawn that produced no new session.
  expect(r.payload.self_evicted).toBe(false);
  expect(
    listActive(db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === oldAgentId,
    ),
  ).toBe(true);
  expect(ctx.chat_agent_id).toBe(oldAgentId);
});

test("remanifest: OLD's prune-tick consumes the kill-signal NEW writes after self-evict", async () => {
  // Regression: pre-fix, remanifest's self-evict cleared
  // `ctx.chat_agent_id` along with dropping chat presence. NEW's
  // login wrote a `rest_requests(target=OLD_agent_id, kind=exit)`
  // row, but OLD's prune-tick consumer first-checked
  // `ctx.chat_agent_id` and early-returned on null. The kill row
  // was never claimed, scheduleExit never fired, and the OLD
  // `claude` process leaked (the row got garbage-collected by
  // `pruneStaleRestRequests` after 5 min).
  //
  // Post-fix: `chat_agent_id` is retained after self-evict. The
  // chat presence row is gone (so NEW boots canonical), but the
  // local id reference survives long enough for the consumer to
  // claim the kill-signal row. SIGTERM scheduled — process exits.
  // This is the path block_self_exit-blocked agents rely on, since
  // they cannot call `exit()` themselves.
  makePersona();
  await call("claim", { username: "wraith" });
  const login = await call("login", {
    username: "wraith",
    project: "pantheon",
    transient: false,
  });
  const oldAgentId = login.payload.agent_id as string;

  const r = await call("remanifest", { handoff: "ctx refresh" });
  expect(r.payload.self_evicted).toBe(true);
  // OLD's chat_agent_id stayed set — the kill-signal pipeline needs it.
  expect(ctx.chat_agent_id).toBe(oldAgentId);

  // Simulate NEW's first-login behavior: write a kill-signal row
  // addressed to OLD's chat agent_id (kind=exit).
  writeRestRequest(db, {
    target_agent_id: oldAgentId,
    from_agent_id: "simulated-new-session",
    kind: "exit",
    reason: "remanifest_complete: wraith is up",
  });

  expect(exitCalls).toEqual([]);

  // OLD's prune-tick consumes.
  const consumed = consumeForceLifecycleRequests(ctx);
  expect(consumed.consumed).toBe(1);
  expect(consumed.exiting).toBe(true);

  // The defining assertion: SIGTERM scheduled. OLD's claude parent
  // exits, the tab closes, the memory leak is resolved.
  expect(exitCalls.length).toBe(1);
  expect(exitCalls[0]!.reason).toBe("force_exit");
});

test("remanifest: emits a system 'remanifesting' message into the project on self-evict", async () => {
  makePersona();
  await call("claim", { username: "wraith" });
  await call("login", {
    username: "wraith",
    project: "pantheon",
    transient: false,
  });

  await call("remanifest", {
    handoff: "context refresh",
  });

  const { tailOnce } = await import("../../../chat/index.ts");
  const events = tailOnce({
    db,
    receiver: {
      agent_id: "system-test-reader",
      username: "peer",
      project: "pantheon",
      mode: "all",
    },
    since_seq: 0,
  });
  const sawNotice = events.some(
    (e) => e.line.includes("wraith") && e.line.includes("remanifesting"),
  );
  expect(sawNotice).toBe(true);
});
