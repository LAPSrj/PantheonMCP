import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { ChatRouter } from "../../../chat/index.ts";
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

/** Launch-param inheritance + override tests for `remanifest`.
 *
 * The new incarnation should boot with the SAME launch params as the
 * session being remanifested (model / effort / permission_mode),
 * recovered from the env spawnPersona persists (PANTHEON_MODEL /
 * PANTHEON_EFFORT / PANTHEON_PERMISSION_MODE), unless the caller passes
 * a per-call override. These tests drive the handler against a recording
 * spawn executor so the new session's exec argv + env can be inspected. */

let tmpDir: string;
let ctx: HandlerContext;
let db: ReturnType<typeof openChatDb>;
let captured: { command: string; args: string[]; env: Record<string, string> } | null;

function makeRecordingExecutor(): SpawnExecutor {
  return {
    spawn(command, args, options): SpawnedProcess {
      captured = {
        command,
        args,
        env: (options.env ?? {}) as Record<string, string>,
      };
      return {
        pid: 34567,
        stderr: Readable.from([]) as unknown as NodeJS.ReadableStream,
        unref() {},
      };
    },
  };
}

function setup(spawnEnv: NodeJS.ProcessEnv) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-remanifest-params-"));
  captured = null;
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  ctx = createContext({
    paths,
    session: new Session("remanifest-old"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 88888,
    platform: "linux",
    spawn_executor: makeRecordingExecutor(),
    stderr_probe_ms: 5,
    spawn_env: spawnEnv,
    chat: router,
  });
}

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
    launch_args: [],
  });
}

async function remanifest(args: Record<string, unknown> = {}) {
  makePersona();
  await call("claim", { username: "wraith" });
  await call("login", { username: "wraith", project: "pantheon", transient: false });
  const r = await call("remanifest", {
    handoff: "context got unwieldy; new incarnation taking over",
    ...args,
  });
  expect(r.ok).toBe(true);
  expect(captured).not.toBeNull();
  return r;
}

/** Read the value following `flag` in the captured argv (e.g.
 * argAfter("--model") → "claude-opus-4-8"). undefined if absent. */
function argAfter(flag: string): string | undefined {
  const i = captured!.args.indexOf(flag);
  return i >= 0 ? captured!.args[i + 1] : undefined;
}

test("remanifest inherits the session's launch model/effort/permission_mode from env", async () => {
  beforeEachEnv({
    PANTHEON_MODEL: "claude-opus-4-8",
    PANTHEON_EFFORT: "high",
    PANTHEON_PERMISSION_MODE: "plan",
  });
  const r = await remanifest();
  expect(argAfter("--model")).toBe("claude-opus-4-8");
  expect(argAfter("--effort")).toBe("high");
  expect(argAfter("--permission-mode")).toBe("plan");
  // Response surfaces what was used.
  const ns = (r.payload.new_session ?? {}) as Record<string, unknown>;
  expect(ns.model).toBe("claude-opus-4-8");
  expect(ns.effort).toBe("high");
  expect(ns.permission_mode).toBe("plan");
});

test("per-call override wins over the inherited launch params", async () => {
  beforeEachEnv({
    PANTHEON_MODEL: "claude-opus-4-8",
    PANTHEON_EFFORT: "high",
    PANTHEON_PERMISSION_MODE: "plan",
  });
  await remanifest({
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    permission_mode: "acceptEdits",
  });
  expect(argAfter("--model")).toBe("claude-haiku-4-5-20251001");
  expect(argAfter("--effort")).toBe("low");
  expect(argAfter("--permission-mode")).toBe("acceptEdits");
});

test("re-persists params forward so the NEXT remanifest also inherits them", async () => {
  beforeEachEnv({
    PANTHEON_MODEL: "claude-opus-4-8",
    PANTHEON_EFFORT: "xhigh",
    PANTHEON_PERMISSION_MODE: "acceptEdits",
  });
  await remanifest();
  expect(captured!.env.PANTHEON_MODEL).toBe("claude-opus-4-8");
  expect(captured!.env.PANTHEON_EFFORT).toBe("xhigh");
  expect(captured!.env.PANTHEON_PERMISSION_MODE).toBe("acceptEdits");
});

test("no inherited model/effort in env → no --model/--effort flag (cascade to persona/machine default)", async () => {
  // Legacy agents (summoned before launch-param persistence shipped)
  // carry no PANTHEON_MODEL/EFFORT — the remanifest must not invent one.
  beforeEachEnv({});
  await remanifest();
  expect(captured!.args.includes("--model")).toBe(false);
  expect(captured!.args.includes("--effort")).toBe(false);
  // permission_mode always resolves to the acceptEdits floor.
  expect(argAfter("--permission-mode")).toBe("acceptEdits");
});

/** Helper: tear down the default fixture and re-setup with a specific
 * spawn env. Lets each test pick its own inherited-param scenario. */
function beforeEachEnv(env: Record<string, string>) {
  try {
    db.close();
  } catch {
    // best-effort
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setup(env as unknown as NodeJS.ProcessEnv);
}

beforeEach(() => {
  // Default fixture; each test resets via beforeEachEnv to its scenario.
  setup({} as NodeJS.ProcessEnv);
});
