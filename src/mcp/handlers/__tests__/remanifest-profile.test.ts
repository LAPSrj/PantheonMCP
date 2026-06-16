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

/** Profile-preservation regression tests for `remanifest`.
 *
 * Bug: `remanifest` built spawnArgs WITHOUT `profile`, so a
 * remanifested agent dropped `--profile`, lost CLAUDE_CONFIG_DIR, and
 * silently relaunched under the default ~/.claude account instead of
 * its work profile (e.g. digital@takt.com).
 *
 * Fix: spawnPersona persists the per-call profile into the spawned
 * process's env as PANTHEON_PROFILE; `remanifest` reads it back from
 * `ctx.spawn_env` and threads it into the new spawn's `--profile`.
 *
 * These tests drive the handler against a recording spawn executor so
 * the new session's exec argv + env can be inspected directly. */

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
        pid: 23456,
        stderr: Readable.from([]) as unknown as NodeJS.ReadableStream,
        unref() {},
      };
    },
  };
}

function setup(spawnEnv: NodeJS.ProcessEnv) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-remanifest-prof-"));
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

beforeEach(() => {
  // Default: a work profile is in env (the post-fix common case).
  setup({ PANTHEON_PROFILE: "work-digital" } as unknown as NodeJS.ProcessEnv);
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
    launch_args: [],
  });
}

async function remanifestWraith() {
  makePersona();
  await call("claim", { username: "wraith" });
  await call("login", { username: "wraith", project: "pantheon", transient: false });
  const r = await call("remanifest", {
    handoff: "context got unwieldy; new incarnation taking over",
  });
  expect(r.ok).toBe(true);
  expect(captured).not.toBeNull();
  return r;
}

test("remanifest threads the agent's --profile into the new session's argv", async () => {
  await remanifestWraith();
  // The new `claude` is launched with the same --profile the calling
  // agent ran under, so the wrapper re-derives CLAUDE_CONFIG_DIR and
  // the incarnation stays on the correct account.
  expect(captured!.args).toContain("--profile=work-digital");
});

test("remanifest re-persists PANTHEON_PROFILE so the NEXT remanifest also preserves it", async () => {
  await remanifestWraith();
  // The new process's env carries PANTHEON_PROFILE forward — the
  // preservation chains across successive remanifests.
  expect(captured!.env.PANTHEON_PROFILE).toBe("work-digital");
});

test("per-call profile override wins over the inherited env profile", async () => {
  // env has work-digital; the caller asks to switch the new incarnation
  // to a different credential profile for this spawn only.
  makePersona();
  await call("claim", { username: "wraith" });
  await call("login", { username: "wraith", project: "pantheon", transient: false });
  const r = await call("remanifest", {
    handoff: "switching accounts for the new incarnation",
    profile: "personal",
  });
  expect(r.ok).toBe(true);
  expect(captured!.args).toContain("--profile=personal");
  expect(captured!.args).not.toContain("--profile=work-digital");
  // The override carries forward so a later remanifest inherits it.
  expect(captured!.env.PANTHEON_PROFILE).toBe("personal");
});

test("per-call profile applies even when no profile is in env (legacy session)", async () => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setup({} as NodeJS.ProcessEnv);
  makePersona();
  await call("claim", { username: "wraith" });
  await call("login", { username: "wraith", project: "pantheon", transient: false });
  const r = await call("remanifest", {
    handoff: "pick an account on remanifest",
    profile: "work-digital",
  });
  expect(r.ok).toBe(true);
  expect(captured!.args).toContain("--profile=work-digital");
});

test("the profile override is NOT written back to the persona", async () => {
  makePersona();
  await call("claim", { username: "wraith" });
  await call("login", { username: "wraith", project: "pantheon", transient: false });
  await call("remanifest", {
    handoff: "switch account, persona unchanged",
    profile: "personal",
  });
  // The persona registration has no profile field and must be untouched
  // by a per-call override — re-read it and confirm nothing leaked in.
  const reread = JSON.parse(
    fs.readFileSync(path.join(ctx.paths.personasDir, "wraith.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(reread.profile).toBeUndefined();
  expect(reread.claude_profile).toBeUndefined();
});

test("remanifest without a profile in env omits --profile (no spurious flag)", async () => {
  // Pre-fix agents (summoned before PANTHEON_PROFILE was persisted)
  // have no profile to recover — the remanifest must not invent one.
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setup({} as NodeJS.ProcessEnv);
  await remanifestWraith();
  expect(captured!.args.some((a) => a.startsWith("--profile"))).toBe(false);
  expect(captured!.env.PANTHEON_PROFILE).toBeUndefined();
});
