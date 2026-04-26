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

// --- channels passthrough ---

test("summon: persona.channels forwards as repeated --channels flags", async () => {
  fixturePersona({ channels: ["plugin:foo@core", "plugin:bar@extra"] });
  await call("summon", { username: "moth-whistle" });
  const argv = recorder[0]!.args;
  // Each channel becomes one --channels <value> pair.
  const idxs: number[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--channels") idxs.push(i);
  expect(idxs).toHaveLength(2);
  expect(argv[idxs[0]! + 1]).toBe("plugin:foo@core");
  expect(argv[idxs[1]! + 1]).toBe("plugin:bar@extra");
});

test("summon: per-call args.channels overrides persona.channels entirely", async () => {
  fixturePersona({ channels: ["plugin:foo@core"] });
  await call("summon", {
    username: "moth-whistle",
    channels: ["plugin:override@x", "plugin:override@y"],
  });
  const argv = recorder[0]!.args;
  // Only the override values appear — persona.channels is NOT additive.
  expect(argv.filter((a) => a === "--channels")).toHaveLength(2);
  expect(argv).toContain("plugin:override@x");
  expect(argv).toContain("plugin:override@y");
  expect(argv).not.toContain("plugin:foo@core");
});

test("summon: no channels anywhere → no --channels flags emitted", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  expect(recorder[0]!.args).not.toContain("--channels");
});

// --- remote_control passthrough ---

test("summon: persona.remote_control true forwards --remote-control with persona.project", async () => {
  fixturePersona({ remote_control: true });
  await call("summon", { username: "moth-whistle" });
  const argv = recorder[0]!.args;
  const idx = argv.indexOf("--remote-control");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("pantheon"); // persona.project from fixture
});

test("summon: per-call remote_control as string overrides the persona.project default", async () => {
  fixturePersona({ remote_control: true });
  await call("summon", { username: "moth-whistle", remote_control: "custom-rc-name" });
  const argv = recorder[0]!.args;
  const idx = argv.indexOf("--remote-control");
  expect(argv[idx + 1]).toBe("custom-rc-name");
});

test("summon: per-call remote_control: false suppresses the flag even when persona has it", async () => {
  fixturePersona({ remote_control: true });
  await call("summon", { username: "moth-whistle", remote_control: false });
  expect(recorder[0]!.args).not.toContain("--remote-control");
});

test("summon: per-call remote_control: true on a persona without rc adds the flag", async () => {
  fixturePersona(); // no remote_control on persona
  await call("summon", { username: "moth-whistle", remote_control: true });
  const argv = recorder[0]!.args;
  const idx = argv.indexOf("--remote-control");
  expect(argv[idx + 1]).toBe("pantheon");
});

test("summon: no remote_control anywhere → flag absent", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  expect(recorder[0]!.args).not.toContain("--remote-control");
});

// --- auto-trust ~/.claude.json ---

test("summon: writes hasTrustDialogAccepted=true to claude_config_path before spawn", async () => {
  fixturePersona();
  // Override to a tmp path so we don't touch the user's real config.
  const cfgPath = path.join(tmpDir, "claude.json");
  ctx = createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    spawn_env: {} as NodeJS.ProcessEnv,
    claude_config_path: cfgPath,
  });
  const r = await call("summon", { username: "moth-whistle" });
  expect(r.ok).toBe(true);
  const trust = r.payload.trust as Record<string, unknown>;
  expect(trust?.path).toBe(cfgPath);
  expect(trust?.trusted_now).toBe(true);
  expect(trust?.trusted_already).toBe(false);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  const projects = cfg.projects as Record<string, Record<string, unknown>>;
  expect(projects["/work/moth"]?.hasTrustDialogAccepted).toBe(true);
});

test("summon: trust call is idempotent on a second summon to the same cwd", async () => {
  fixturePersona();
  const cfgPath = path.join(tmpDir, "claude.json");
  ctx = createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    spawn_env: {} as NodeJS.ProcessEnv,
    claude_config_path: cfgPath,
  });
  await call("summon", { username: "moth-whistle" });
  const second = await call("summon", { username: "moth-whistle" });
  const trust = second.payload.trust as Record<string, unknown>;
  expect(trust?.trusted_now).toBe(false);
  expect(trust?.trusted_already).toBe(true);
});
