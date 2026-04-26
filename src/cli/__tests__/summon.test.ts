import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { createPersona } from "../../identity/index.ts";
import {
  type NodeSpawnOptions,
  type SpawnExecutor,
  type SpawnedProcess,
} from "../../launcher/index.ts";
import { runSummon } from "../summon.ts";

let tmpDir: string;
let paths: Paths;
let recorder: SpawnRecord[];
let mockStderr: string;

interface SpawnRecord {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

class StringSink extends Writable {
  buf = "";
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

function makeMockExecutor(): SpawnExecutor {
  return {
    spawn(command, args, opts: NodeSpawnOptions): SpawnedProcess {
      recorder.push({
        command,
        args,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
      const stderrText = mockStderr;
      const stderr = stderrText
        ? (Readable.from([stderrText]) as unknown as NodeJS.ReadableStream)
        : (Readable.from([]) as unknown as NodeJS.ReadableStream);
      return {
        pid: 22000 + Math.floor(Math.random() * 1000),
        stderr,
        unref() {},
      };
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-summon-cli-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  recorder = [];
  mockStderr = "";
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedPersona() {
  createPersona(paths, {
    username: "swoopfinch",
    project: "test-block",
    cwd: "/work/swoopfinch",
    platform: "linux",
    description: "builder",
    expertise: ["typescript"],
    owns: ["/repos/swoopfinch"],
    launch_command: "claude",
    launch_args: ["--print"],
    color: "purple",
  });
}

test("--help exits 0", async () => {
  const stdout = new StringSink();
  const stderr = new StringSink();
  const code = await runSummon({ args: ["--help"], stdout, stderr, paths });
  expect(code).toBe(0);
  expect(stderr.buf).toContain("Usage: pantheon summon");
  expect(stderr.buf).toContain("--target-mode");
});

test("missing username → exit 1 + usage hint", async () => {
  const stdout = new StringSink();
  const stderr = new StringSink();
  const code = await runSummon({ args: [], stdout, stderr, paths });
  expect(code).toBe(1);
  expect(stderr.buf).toContain("<username> is required");
});

test("unknown persona → exit 1", async () => {
  const stdout = new StringSink();
  const stderr = new StringSink();
  const code = await runSummon({
    args: ["ghost"],
    stdout,
    stderr,
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  expect(code).toBe(1);
  expect(stderr.buf).toContain("not registered");
});

test("bad --target-mode → exit 1", async () => {
  seedPersona();
  const stderr = new StringSink();
  const code = await runSummon({
    args: ["swoopfinch", "--target-mode", "bogus"],
    stdout: new StringSink(),
    stderr,
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  expect(code).toBe(1);
  expect(stderr.buf).toContain("--target-mode must be one of");
});

test("happy path: argv builds the right SpawnArgs and prints JSON result", async () => {
  seedPersona();
  const stdout = new StringSink();
  const stderr = new StringSink();
  const code = await runSummon({
    args: [
      "swoopfinch",
      "--target-mode",
      "split-pane",
      "--target-window",
      "image-gallery-finish",
      "--target-split",
      "h",
      "--rest-timeout",
      "3600",
      "--prompt",
      "back at it",
    ],
    stdout,
    stderr,
    paths,
    spawn_executor: makeMockExecutor(),
    // Force WT detection so split-pane is supported (no downgrade).
    spawn_env: { WT_SESSION: "test" } as NodeJS.ProcessEnv,
  });
  expect(code).toBe(0);
  // Spawn was called with WT argv.
  expect(recorder).toHaveLength(1);
  expect(recorder[0]!.command).toBe("wt.exe");
  expect(recorder[0]!.args).toContain("-w");
  expect(recorder[0]!.args).toContain("image-gallery-finish");
  expect(recorder[0]!.args).toContain("split-pane");
  expect(recorder[0]!.args).toContain("-H");
  // Persona env vars exported.
  expect(recorder[0]!.env?.PANTHEON_USERNAME).toBe("swoopfinch");
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("3600");
  // Output is JSON with the spawn shape.
  const payload = JSON.parse(stdout.buf) as Record<string, unknown>;
  expect(payload.ok).toBe(true);
  expect(payload.summoned).toBe("swoopfinch");
  expect(payload.spawn_pid).toBeGreaterThan(0);
  expect(payload.adapter).toBe("wt");
  expect(payload.resolved_mode).toBe("split-pane");
});

test("--rest-timeout never propagates verbatim", async () => {
  seedPersona();
  await runSummon({
    args: ["swoopfinch", "--rest-timeout", "never"],
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  expect(recorder[0]!.env?.PANTHEON_REST_TIMEOUT).toBe("never");
});

test("split-pane with stderr probe captured → exit 2 (spawn_failed)", async () => {
  seedPersona();
  mockStderr = "wt: split-pane refused";
  const stderr = new StringSink();
  const code = await runSummon({
    args: ["swoopfinch", "--target-mode", "split-pane"],
    stdout: new StringSink(),
    stderr,
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: { WT_SESSION: "test" } as NodeJS.ProcessEnv,
  });
  expect(code).toBe(2);
  expect(stderr.buf).toContain("spawn_failed");
  expect(stderr.buf).toContain("split-pane refused");
});

test("--target-strict on unsupported mode → exit 1", async () => {
  seedPersona();
  const stderr = new StringSink();
  // No host terminal env; generic adapter only supports new-window.
  const code = await runSummon({
    args: ["swoopfinch", "--target-mode", "split-pane", "--target-strict"],
    stdout: new StringSink(),
    stderr,
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  expect(code).toBe(1);
  expect(stderr.buf).toContain("unsupported_capability");
});

// --- channels passthrough ---

test("--channels (repeatable) forwards each value as a --channels flag to claude", async () => {
  seedPersona();
  await runSummon({
    args: [
      "swoopfinch",
      "--channels",
      "plugin:foo@core",
      "--channels",
      "plugin:bar@extra",
    ],
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  const argv = recorder[0]!.args;
  const idxs: number[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--channels") idxs.push(i);
  expect(idxs).toHaveLength(2);
  expect(argv[idxs[0]! + 1]).toBe("plugin:foo@core");
  expect(argv[idxs[1]! + 1]).toBe("plugin:bar@extra");
});

test("--channels with no value → exit 1", async () => {
  seedPersona();
  const stderr = new StringSink();
  const code = await runSummon({
    args: ["swoopfinch", "--channels"],
    stdout: new StringSink(),
    stderr,
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  expect(code).toBe(1);
  expect(stderr.buf).toContain("--channels requires a value");
});

// --- remote-control / -rc passthrough ---

test("--rc alone forwards --remote-control with the persona's project as default name", async () => {
  seedPersona();
  await runSummon({
    args: ["swoopfinch", "--rc"],
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  const argv = recorder[0]!.args;
  const idx = argv.indexOf("--remote-control");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("test-block"); // persona.project from seedPersona
});

test("--remote-control <name> forwards the explicit name", async () => {
  seedPersona();
  await runSummon({
    args: ["swoopfinch", "--remote-control", "my-rc"],
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  const argv = recorder[0]!.args;
  const idx = argv.indexOf("--remote-control");
  expect(argv[idx + 1]).toBe("my-rc");
});

test("--rc followed by another flag treats --rc as boolean (no name eaten)", async () => {
  seedPersona();
  await runSummon({
    args: ["swoopfinch", "--rc", "--prompt", "hi"],
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  const argv = recorder[0]!.args;
  const idx = argv.indexOf("--remote-control");
  expect(argv[idx + 1]).toBe("test-block");
  // --prompt 'hi' is now bootstrap-wrapped — assert via substring.
  expect(argv.some((a) => a.includes("hi"))).toBe(true);
});

test("--rc honors persisted persona.remote_control via just running --help on a persona that has it", async () => {
  // No persona-level set test in CLI suite; covered fully in src/mcp/__tests__/spawn.test.ts.
  // This one just guarantees CLI flag and persona-default coexist without crashing.
  createPersona(paths, {
    username: "rcuser",
    project: "rc-project",
    cwd: "/work/rc",
    platform: "linux",
    description: "rc default user",
    expertise: ["x"],
    owns: ["/repos/rc"],
    launch_command: "claude",
    launch_args: [],
    remote_control: true,
  });
  await runSummon({
    args: ["rcuser"],
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
    spawn_executor: makeMockExecutor(),
    spawn_env: {} as NodeJS.ProcessEnv,
  });
  const argv = recorder[0]!.args;
  const idx = argv.indexOf("--remote-control");
  expect(argv[idx + 1]).toBe("rc-project");
});
