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
  // generic adapter (no host terminal env): claude --print "<bootstrap + prompt>"
  expect(call0.command).toBe("claude");
  expect(call0.args.slice(0, 1)).toEqual(["--print"]);
  // Last arg is the bootstrap-wrapped prompt; assert both bootstrap markers
  // and the runtime prompt are embedded.
  const finalArg = call0.args[call0.args.length - 1] as string;
  expect(finalArg).toContain("mcp__pantheon__login");
  expect(finalArg).toContain("moth-whistle");
  expect(finalArg).toContain("do the thing");
  expect(call0.env?.PANTHEON_SUMMONED).toBe("1");
  expect(call0.env?.PANTHEON_USERNAME).toBe("moth-whistle");
  // Default rest_timeout is "never" (auto-rest off) when omitted.
  expect(call0.env?.PANTHEON_REST_TIMEOUT).toBe("never");
  // Per-spawn graceful-exit sentinel: path under tmpdir, unique per
  // spawn, consumed by makeRealExitScheduler + the wt bash wrapper.
  expect(call0.env?.PANTHEON_EXIT_SENTINEL).toMatch(/pantheon-exit-\d+-/);
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

test("summon: block_self_exit=true sets PANTHEON_BLOCK_SELF_EXIT=1 in child env", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle", block_self_exit: true });
  expect(recorder[0]!.env?.PANTHEON_BLOCK_SELF_EXIT).toBe("1");
});

test("summon: block_self_exit defaults to off (env var unset)", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  expect(recorder[0]!.env?.PANTHEON_BLOCK_SELF_EXIT).toBeUndefined();
});

test("summon: block_self_exit=false explicitly omits the env var", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle", block_self_exit: false });
  expect(recorder[0]!.env?.PANTHEON_BLOCK_SELF_EXIT).toBeUndefined();
});

test("summon: PANTHEON_* parent-env pollution does NOT propagate to child (launcher strips)", async () => {
  // The launcher strips PANTHEON_* from inherited env before merging
  // plan.env, so a summoned parent (which itself has PANTHEON_USERNAME
  // / PANTHEON_BLOCK_SELF_EXIT / PANTHEON_COLOR set) doesn't silently
  // leak those vars into children whose spawn handler set them only
  // conditionally (or not at all). Without this strip, a parent with
  // block_self_exit:true would propagate that flag to every grandchild.
  fixturePersona();
  const stash: Record<string, string | undefined> = {
    PANTHEON_BLOCK_SELF_EXIT: process.env.PANTHEON_BLOCK_SELF_EXIT,
    PANTHEON_COLOR: process.env.PANTHEON_COLOR,
    PANTHEON_REMANIFEST_OF: process.env.PANTHEON_REMANIFEST_OF,
  };
  process.env.PANTHEON_BLOCK_SELF_EXIT = "1";
  process.env.PANTHEON_COLOR = "red";
  process.env.PANTHEON_REMANIFEST_OF = "ghost-agent";
  try {
    await call("summon", { username: "moth-whistle" });
    expect(recorder[0]!.env?.PANTHEON_BLOCK_SELF_EXIT).toBeUndefined();
    expect(recorder[0]!.env?.PANTHEON_COLOR).toBeUndefined();
    expect(recorder[0]!.env?.PANTHEON_REMANIFEST_OF).toBeUndefined();
    // PANTHEON_* that the spawn handler DOES set explicitly should
    // land in the child env (sanity: the strip didn't eat too much).
    expect(recorder[0]!.env?.PANTHEON_USERNAME).toBe("moth-whistle");
    expect(recorder[0]!.env?.PANTHEON_SUMMONED).toBe("1");
    // Non-PANTHEON inherited vars should pass through normally.
    expect(recorder[0]!.env?.PATH).toBeDefined();
  } finally {
    for (const [k, v] of Object.entries(stash)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

test("summon: persona.mode === 'resume' defaults args.resume to true", async () => {
  const persona = fixturePersona({ mode: "resume" });
  const { writePersona } = await import("../../identity/index.ts");
  writePersona(ctx.paths, { ...persona, resume_session_id: "session-xyz" });

  // No explicit resume arg — should still resume because of mode.
  await call("summon", { username: "moth-whistle" });
  const argv = recorder[0]!.args;
  expect(argv).toContain("--resume");
  expect(argv).toContain("session-xyz");
});

test("summon: explicit resume:false beats persona.mode === 'resume'", async () => {
  const persona = fixturePersona({ mode: "resume" });
  const { writePersona } = await import("../../identity/index.ts");
  writePersona(ctx.paths, { ...persona, resume_session_id: "session-xyz" });

  await call("summon", { username: "moth-whistle", resume: false });
  const argv = recorder[0]!.args;
  expect(argv).not.toContain("--resume");
});

test("summon: rest_timeout 'never' propagates via PANTHEON_REST_TIMEOUT env", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle", rest_timeout: "never" });
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("never");
});

test("summon: omitted rest_timeout defaults to 'never'", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("never");
});

test("summon: explicit numeric rest_timeout still propagates verbatim", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle", rest_timeout: 7200 });
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("7200");
});

test("summon: block_self_exit keeps the 60-min safety-valve default when rest_timeout omitted", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle", block_self_exit: true });
  // A blocked agent has no self-exit path, so it retains a finite timer
  // instead of inheriting the general "never" default.
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("3600");
});

test("summon: block_self_exit with explicit rest_timeout 'never' opts out of the valve", async () => {
  fixturePersona();
  await call("summon", {
    username: "moth-whistle",
    block_self_exit: true,
    rest_timeout: "never",
  });
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("never");
});

// --- permission_mode cascade ---

function lastSpawnArgs(): string[] {
  return recorder[recorder.length - 1]!.args;
}

function permissionModeFromArgs(args: string[]): string | null {
  const i = args.indexOf("--permission-mode");
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

test("permission_mode cascade: floor is 'acceptEdits' when nothing else set", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  expect(permissionModeFromArgs(lastSpawnArgs())).toBe("acceptEdits");
});

test("permission_mode cascade: persona.permission_mode wins over the floor", async () => {
  fixturePersona({ permission_mode: "plan" });
  await call("summon", { username: "moth-whistle" });
  expect(permissionModeFromArgs(lastSpawnArgs())).toBe("plan");
});

test("permission_mode cascade: per-call arg wins over persona.permission_mode", async () => {
  fixturePersona({ permission_mode: "plan" });
  await call("summon", {
    username: "moth-whistle",
    permission_mode: "bypassPermissions",
  });
  expect(permissionModeFromArgs(lastSpawnArgs())).toBe("bypassPermissions");
});

test("permission_mode cascade: PANTHEON_DEFAULT_PERMISSION_MODE env wins over the floor when persona unset", async () => {
  // Rebuild ctx with the env var set; spawn_env is read by the resolver.
  const paths = ctx.paths;
  const newCtx = createContext({
    paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: "linux",
    spawn_executor: ctx.spawn_executor,
    stderr_probe_ms: 5,
    spawn_env: { PANTHEON_DEFAULT_PERMISSION_MODE: "plan" } as NodeJS.ProcessEnv,
  });
  fixturePersona();
  await dispatch("summon", { username: "moth-whistle" }, newCtx);
  expect(permissionModeFromArgs(lastSpawnArgs())).toBe("plan");
});

test("permission_mode cascade: persona.permission_mode beats the env default", async () => {
  const paths = ctx.paths;
  const newCtx = createContext({
    paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: "linux",
    spawn_executor: ctx.spawn_executor,
    stderr_probe_ms: 5,
    spawn_env: { PANTHEON_DEFAULT_PERMISSION_MODE: "plan" } as NodeJS.ProcessEnv,
  });
  fixturePersona({ permission_mode: "default" });
  await dispatch("summon", { username: "moth-whistle" }, newCtx);
  expect(permissionModeFromArgs(lastSpawnArgs())).toBe("default");
});

test("permission_mode cascade: invalid per-call value rejected at dispatch (strict args validation)", async () => {
  fixturePersona({ permission_mode: "plan" });
  const r = await call("summon", { username: "moth-whistle", permission_mode: "garbage" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
  // No spawn happened — bad enum value rejected at the boundary.
  expect(recorder.length).toBe(0);
});

test("permission_mode: --permission-mode flag is always present in argv", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  const args = lastSpawnArgs();
  expect(args).toContain("--permission-mode");
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

  // Spawn argv recorded; the prompt is now wrapped in the
  // provisional-bootstrap, so verify by substring.
  expect(recorder).toHaveLength(1);
  const finalArg = recorder[0]!.args[recorder[0]!.args.length - 1] as string;
  expect(finalArg).toContain("you are a new helper; please update_profile first");
  // Provisional bootstrap markers.
  expect(finalArg).toContain("PROVISIONAL");
  expect(finalArg).toContain("mcp__pantheon__update_profile");
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
    summoner: "alice",
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

// --- pane geometry: multi-summon end-to-end ---

test("five sequential split-pane summons WITHOUT explicit tab_index still evolve to [2,2,1] (Leandro repro)", async () => {
  // Repro for semaphoremole's report: when the CLI summons split-pane
  // and doesn't pass --target-tab-index, the spawn handler must default
  // to the LAST EXISTING tab (not predict a new tab via tabCount).
  // The previous test below had explicit tab_index=0 and masked this bug.
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
  fixturePersona({ username: "alpha" });
  fixturePersona({ username: "beta", cwd: "/work/beta" });
  fixturePersona({ username: "gamma", cwd: "/work/gamma" });
  fixturePersona({ username: "delta", cwd: "/work/delta" });
  fixturePersona({ username: "epsilon", cwd: "/work/epsilon" });

  await call("summon", {
    username: "alpha",
    target: { mode: "new-tab-window", window: "wname" },
  });
  // CRITICAL: no tab_index in any of these.
  for (const u of ["beta", "gamma", "delta", "epsilon"]) {
    await call("summon", {
      username: u,
      target: { mode: "split-pane", window: "wname" },
    });
  }
  const { getTabGeometry } = await import("../../launcher/index.ts");
  const g = getTabGeometry(ctx.paths, "wname", 0);
  expect(g).not.toBeNull();
  // Without the fix this would be [[0],[1],[2],[3],[4]] = [1,1,1,1,1].
  expect(g!.columns.map((c) => c.length)).toEqual([2, 2, 1]);
});

test("five sequential split-pane summons evolve the tab's geometry to shape [2,2,1] AND emit focus-pane argv", async () => {
  // Force WT detection so split-pane is supported.
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
  fixturePersona({ username: "alpha" });
  fixturePersona({ username: "beta", cwd: "/work/beta" });
  fixturePersona({ username: "gamma", cwd: "/work/gamma" });
  fixturePersona({ username: "delta", cwd: "/work/delta" });
  fixturePersona({ username: "epsilon", cwd: "/work/epsilon" });

  // First summon: new-tab-window (seeds the tab geometry).
  await call("summon", {
    username: "alpha",
    target: { mode: "new-tab-window", window: "image-gallery" },
  });
  // Four split-pane follow-ups into the same window/tab.
  for (const u of ["beta", "gamma", "delta", "epsilon"]) {
    await call("summon", {
      username: u,
      target: { mode: "split-pane", window: "image-gallery", tab_index: 0 },
    });
  }

  const { getTabGeometry } = await import("../../launcher/index.ts");
  const g = getTabGeometry(ctx.paths, "image-gallery", 0);
  expect(g).not.toBeNull();
  expect(g!.columns.map((c) => c.length)).toEqual([2, 2, 1]);

  // Each split-pane spawn should have emitted focus-pane in the argv.
  const splitInvocations = recorder.slice(1); // skip the new-tab seed
  for (const inv of splitInvocations) {
    expect(inv.args).toContain("focus-pane");
    expect(inv.args).toContain("split-pane");
  }
});

test("split-pane: caller-explicit target.split overrides policy direction; focus_pane stays policy-chosen", async () => {
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
  fixturePersona({ username: "alpha" });
  fixturePersona({ username: "beta", cwd: "/work/beta" });
  // Seed the tab.
  await call("summon", {
    username: "alpha",
    target: { mode: "new-tab-window", window: "win" },
  });
  // Caller forces horizontal even though the policy would say vertical
  // (n=1 → cols<3 + rows>=cols → add column → V).
  await call("summon", {
    username: "beta",
    target: { mode: "split-pane", window: "win", split: "horizontal" },
  });
  const splitInv = recorder[1]!;
  // Direction the caller asked for.
  expect(splitInv.args).toContain("-H");
  expect(splitInv.args).not.toContain("-V");
  // focus-pane is still emitted (policy-chosen target pane).
  expect(splitInv.args).toContain("focus-pane");
});

// --- new-tab-here mode: window-name asymmetry vs other modes ---

test("summon new-tab-here from a human-launched caller renders -w 0 (current window)", async () => {
  // Bug repro: pre-fix, the spawn handler unconditionally fell back to
  // `summon-<persona>` as the windowName for `new-tab-here`, which wt
  // renders as `wt.exe -w summon-<persona> new-tab ...`. WT's open-or-
  // create semantics then spawned a fresh window with that name —
  // exactly the wrong behavior; the semantic of new-tab-here is "land
  // in the caller's current window." Fix: mode-gated default that
  // falls back to "current" when the caller doesn't have a
  // PANTHEON_WINDOW_NAME env (human-launched session).
  ctx = createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    // WT_SESSION present (so wt adapter is detected), but no
    // PANTHEON_WINDOW_NAME — this is a human-launched CC session.
    spawn_env: { WT_SESSION: "test" } as NodeJS.ProcessEnv,
  });
  fixturePersona();
  await call("summon", {
    username: "moth-whistle",
    target: { mode: "new-tab-here" },
  });
  const argv = recorder[0]!.args;
  // First two args are `-w <window-arg>`. For "new-tab-here" without
  // an explicit window override and without an inherited
  // PANTHEON_WINDOW_NAME, the windowName resolves to "current" which
  // the wt adapter maps to "0" (current window).
  expect(argv[0]).toBe("-w");
  expect(argv[1]).toBe("0");
  // CRITICAL regression guard: NEVER fall back to `summon-<persona>`
  // for new-tab-here. That was the bug.
  expect(argv).not.toContain("summon-moth-whistle");
});

test("summon new-tab-here from a summoned caller inherits PANTHEON_WINDOW_NAME", async () => {
  // When the caller is itself a summoned agent in a named window
  // (e.g. `summon-righthand`), a `new-tab-here` summon from that
  // caller should drop the new tab into the SAME named window — so
  // the wt adapter argv must carry that name, not "0".
  ctx = createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    spawn_env: {
      WT_SESSION: "test",
      PANTHEON_WINDOW_NAME: "summon-righthand",
    } as NodeJS.ProcessEnv,
  });
  fixturePersona();
  await call("summon", {
    username: "moth-whistle",
    target: { mode: "new-tab-here" },
  });
  const argv = recorder[0]!.args;
  expect(argv[0]).toBe("-w");
  expect(argv[1]).toBe("summon-righthand");
  // Still must not derive from the SPAWNED persona; the caller's
  // identity is the load-bearing signal.
  expect(argv).not.toContain("summon-moth-whistle");
});

test("summon new-tab-here with caller-explicit target.window still wins", async () => {
  // Regression guard: the mode-gated default must not override an
  // explicit `target.window` from the caller — that field has always
  // been the caller's escape hatch and remains authoritative.
  ctx = createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    spawn_executor: makeMockExecutor(() => mockStderr),
    stderr_probe_ms: 5,
    spawn_env: {
      WT_SESSION: "test",
      PANTHEON_WINDOW_NAME: "summon-righthand",
    } as NodeJS.ProcessEnv,
  });
  fixturePersona();
  await call("summon", {
    username: "moth-whistle",
    target: { mode: "new-tab-here", window: "my-explicit-window" },
  });
  const argv = recorder[0]!.args;
  expect(argv[0]).toBe("-w");
  expect(argv[1]).toBe("my-explicit-window");
});

test("summon: bare summon (no --prompt) STILL embeds the bootstrap so the agent logs into chat", async () => {
  fixturePersona();
  await call("summon", { username: "moth-whistle" });
  const finalArg = recorder[0]!.args[recorder[0]!.args.length - 1] as string;
  expect(finalArg).toContain("mcp__pantheon__login");
  expect(finalArg).toContain("moth-whistle");
  // Watcher instruction (the bug semaphoremole reported was that
  // spawned agents had no instruction to start the watcher).
  expect(finalArg).toContain("Monitor(...)");
  // Memory read instruction.
  expect(finalArg).toContain("mcp__pantheon__get_memory");
  // No runtime prompt — placeholder appears so the section stays.
  expect(finalArg).toContain("(no runtime prompt");
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
