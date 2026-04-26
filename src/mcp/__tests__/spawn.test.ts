import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { resolvePaths } from "../../storage/index.ts";
import { Session, createPersona } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import {
  loadRegistry,
  type SpawnExecutor,
  type SpawnedProcess,
} from "../../launcher/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;
let recorder: SpawnRecord[];
let mockStderr: string;

interface SpawnRecord {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

function makeMockExecutor(getStderr: () => string): SpawnExecutor {
  return {
    spawn(command, args, options): SpawnedProcess {
      recorder.push({
        command,
        args,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      });
      const stderrText = getStderr();
      const stderr = stderrText
        ? Readable.from([stderrText]) as unknown as NodeJS.ReadableStream
        : null;
      return {
        pid: 12345,
        stderr,
        unref() {},
      };
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-spawn-"));
  recorder = [];
  mockStderr = "";
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    spawn_env: {} as NodeJS.ProcessEnv,
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

function fixturePersona(over: Record<string, unknown> = {}) {
  return createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "pantheon",
    cwd: "/work/moth",
    platform: "linux",
    description: "chat router peer",
    expertise: ["chat"],
    owns: ["/repos/chat-mcp"],
    launch_command: "claude",
    launch_args: ["--print"],
    ...over,
  });
}

// --- summon happy path ---

test("summon: composes registry → plan → spawn → recordSpawn → stamps", async () => {
  fixturePersona();
  const r = await call("summon", { username: "moth-whistle", prompt: "do the thing" });
  expect(r.ok).toBe(true);
  expect(r.payload.summoned).toBe("moth-whistle");
  expect(r.payload.project).toBe("pantheon");
  expect(r.payload.cwd).toBe("/work/moth");
  expect(r.payload.spawn_pid).toBe(12345);
  expect(r.payload.tab_title).toBe("moth-whistle");

  // The mock executor recorded the spawn argv.
  expect(recorder).toHaveLength(1);
  const call0 = recorder[0]!;
  // generic adapter (no host terminal env): claude --print "do the thing"
  expect(call0.command).toBe("claude");
  expect(call0.args).toEqual(["--print", "do the thing"]);
  expect(call0.env?.PANTHEON_SUMMONED).toBe("1");
  expect(call0.env?.PANTHEON_USERNAME).toBe("moth-whistle");
  expect(call0.env?.PANTHEON_REST_TIMEOUT).toBe("3600");
  expect(call0.cwd).toBe("/work/moth");

  // Window registry recorded the spawn under the default name.
  const reg = loadRegistry(ctx.paths);
  expect(reg.windows["summon-moth-whistle"]?.tabCount).toBe(1);
  expect(reg.windows["summon-moth-whistle"]?.tabSpawnHistory[0]?.persona).toBe("moth-whistle");

  // Persona registry stamped: summon_count incremented + last_summoned_at set.
  const { readPersona } = await import("../../identity/index.ts");
  const stamped = readPersona(ctx.paths, "moth-whistle");
  expect(stamped?.summon_count).toBe(1);
  expect(stamped?.last_summoned_at).not.toBeNull();
});

test("summon: resume + saved session id appends --resume <id>", async () => {
  const persona = fixturePersona();
  // Simulate a previous summon having stored a resume id.
  const { writePersona } = await import("../../identity/index.ts");
  writePersona(ctx.paths, { ...persona, resume_session_id: "session-abc" });

  await call("summon", { username: "moth-whistle", resume: true });
  const argv = recorder[0]!.args;
  // launch_args ['--print'] preserved, then --resume session-abc, then no prompt.
  expect(argv).toContain("--resume");
  expect(argv).toContain("session-abc");
});

test("summon: rest_timeout 'never' propagates via PANTHEON_REST_TIMEOUT env", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle", rest_timeout: "never" });
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("never");
});

// --- summon project gate ---

test("summon errors cross_project_blocked when caller's persona is in another project", async () => {
  // Caller is in project 'A'.
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "A",
    cwd: "/repos/A",
    platform: "linux",
  });
  await call("claim", { username: "vellumpike" });
  // Target is in project 'B'.
  createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "B",
    cwd: "/repos/B",
    platform: "linux",
  });

  const blocked = await call("summon", { username: "moth-whistle" });
  expect(blocked.ok).toBe(false);
  expect(blocked.payload.error).toBe("cross_project_blocked");

  // summon_any bypasses the gate.
  const allowed = await call("summon_any", { username: "moth-whistle" });
  expect(allowed.ok).toBe(true);
});

// --- spawn_failed via stderr probe ---

test("summon: split-pane spawn that captures stderr returns spawn_failed", async () => {
  // Re-init the context with a host-terminal env so split-pane is
  // actually supported (otherwise the dispatcher downgrades and the
  // stderr probe never fires).
  ctx = createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    spawn_env: { WT_SESSION: "test" } as NodeJS.ProcessEnv,
  });
  fixturePersona();
  mockStderr = "wt: split-pane refused (pane too small)";
  const r = await call("summon", {
    username: "moth-whistle",
    target: { mode: "split-pane" },
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("spawn_failed");
  expect(r.payload.stderr).toContain("split-pane refused");
  expect(r.payload.adapter).toBeDefined();
});

// --- conjure: register-then-spawn atomicity ---

test("conjure registers a provisional persona then spawns", async () => {
  const r = await call("conjure", {
    username: "freshfern",
    cwd: "/work/fresh",
    project: "pantheon",
    prompt: "you are a new helper; please update_profile first",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.conjured).toBe(true);
  expect(r.payload.provisional).toBe(true);
  expect(r.payload.bootstrap_required).toContain("update_profile");

  const { readPersona } = await import("../../identity/index.ts");
  const persona = readPersona(ctx.paths, "freshfern");
  expect(persona?.provisional).toBe(true);
  expect(persona?.project).toBe("pantheon");
  expect(persona?.cwd).toBe("/work/fresh");

  // Spawn argv recorded.
  expect(recorder).toHaveLength(1);
  expect(recorder[0]!.args).toContain("you are a new helper; please update_profile first");
});

test("conjure rejects with cross_project_blocked when caller is in another project", async () => {
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "A",
    cwd: "/repos/A",
    platform: "linux",
  });
  await call("claim", { username: "vellumpike" });
  const r = await call("conjure", {
    username: "freshfern",
    cwd: "/work/fresh",
    project: "B",
    prompt: "x",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("cross_project_blocked");
});

test("conjure_any bypasses the project gate", async () => {
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "A",
    cwd: "/repos/A",
    platform: "linux",
  });
  await call("claim", { username: "vellumpike" });
  const r = await call("conjure_any", {
    username: "freshfern",
    cwd: "/work/fresh",
    project: "B",
    prompt: "x",
  });
  expect(r.ok).toBe(true);
});

// --- exit teardown ---

test("exit unregisters the watchdog timer", async () => {
  ctx.watchdog.register({
    session: ctx.session,
    rest_timeout: 3600,
    onDeadline: () => {},
  });
  expect(ctx.watchdog.inspect("test-session")).not.toBeNull();
  await call("exit", { delay_seconds: 0 });
  expect(ctx.watchdog.inspect("test-session")).toBeNull();
});

test("exit decrements the window registry when this session was summoned", async () => {
  // Seed the registry as if this session was just spawned.
  const { recordSpawn, getWindowState } = await import("../../launcher/index.ts");
  recordSpawn(ctx.paths, "summon-vellumpike", {
    summoner: "leandro",
    persona: "vellumpike",
    tab_index: 0,
  });
  expect(getWindowState(ctx.paths, "summon-vellumpike")?.tabCount).toBe(1);

  // Re-create the context with spawn metadata.
  ctx = createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    spawn_env: {} as NodeJS.ProcessEnv,
    spawn_metadata: { window_name: "summon-vellumpike", tab_index: 0 },
  });
  const r = await call("exit", { delay_seconds: 0 });
  expect(r.payload.registry_decremented).toBe(true);
  expect(getWindowState(ctx.paths, "summon-vellumpike")?.tabCount).toBe(0);
});

test("exit is a no-op on the registry when this session was not summoned", async () => {
  const r = await call("exit", { delay_seconds: 0 });
  expect(r.payload.registry_decremented).toBe(false);
});

test("summon sets PANTHEON_WINDOW_NAME + PANTHEON_TAB_INDEX in spawned env", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  expect(recorder[0]!.env?.PANTHEON_WINDOW_NAME).toBe("summon-moth-whistle");
  expect(recorder[0]!.env?.PANTHEON_TAB_INDEX).toBe("0");
});
