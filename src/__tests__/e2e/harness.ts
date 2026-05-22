import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { ChatRouter } from "../../chat/index.ts";
import { Session } from "../../identity/index.ts";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
import { Watchdog, realScheduler, type Scheduler } from "../../watchdog/index.ts";
import { createContext } from "../../mcp/context.ts";
import { dispatch } from "../../mcp/dispatch.ts";
import type { HandlerContext } from "../../mcp/types.ts";
import type {
  NodeSpawnOptions,
  SpawnedProcess,
  SpawnExecutor,
} from "../../launcher/index.ts";

/** Shared E2E harness: two HandlerContexts backed by the same
 * filesystem (PANTHEON_HOME tmpdir) so cross-process behavior
 * — chat.db presence/persistence, persona registry, memory
 * files — exercises end-to-end. */

export interface E2EProcess {
  ctx: HandlerContext;
  /** Captured spawn calls from this process's mock executor. */
  spawned: SpawnRecord[];
  /** Captured scheduleExit calls — each entry is one invocation
   * (delay_seconds, reason). Lets tests assert that a code path
   * actually scheduled SIGTERM, not just flipped state. */
  exitCalls: { delay_seconds: number; reason: string }[];
  db: ReturnType<typeof openChatDb>;
}

export interface SpawnRecord {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface E2EFixture {
  tmpDir: string;
  paths: Paths;
  procA: E2EProcess;
  procB: E2EProcess;
  cleanup: () => void;
}

export interface FixtureOptions {
  schedulerA?: Scheduler;
  schedulerB?: Scheduler;
}

export function makeFixture(options: FixtureOptions = {}): E2EFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-e2e-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  const procA = makeProcess("sess-a", paths, options.schedulerA ?? realScheduler);
  const procB = makeProcess("sess-b", paths, options.schedulerB ?? realScheduler);
  return {
    tmpDir,
    paths,
    procA,
    procB,
    cleanup() {
      try {
        procA.db.close();
      } catch {
        // best-effort
      }
      try {
        procB.db.close();
      } catch {
        // best-effort
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function makeProcess(
  sessionId: string,
  paths: Paths,
  scheduler: Scheduler,
): E2EProcess {
  const spawned: SpawnRecord[] = [];
  const exitCalls: { delay_seconds: number; reason: string }[] = [];
  const executor: SpawnExecutor = {
    spawn(command, args, opts: NodeSpawnOptions): SpawnedProcess {
      spawned.push({
        command,
        args,
        env: opts.env ?? {},
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
      // Plain in-process stub. The spawn handler's stderr-probe path
      // expects either a Readable or null; pass null so plans without
      // requires_stderr_probe don't try to read.
      return {
        pid: 11000 + Math.floor(Math.random() * 1000),
        stderr: Readable.from([]) as unknown as NodeJS.ReadableStream,
        unref() {},
      };
    },
  };
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  const ctx = createContext({
    paths,
    session: new Session(sessionId),
    watchdog: new Watchdog(scheduler),
    parent_pid: 9000,
    platform: "linux",
    spawn_executor: executor,
    stderr_probe_ms: 5,
    spawn_env: {} as NodeJS.ProcessEnv,
    chat: router,
    scheduleExit: (delay_seconds, reason) => {
      exitCalls.push({ delay_seconds, reason });
    },
  });
  return { ctx, spawned, exitCalls, db };
}

/** Convenience: dispatch a tool and parse the JSON result. */
export async function call(
  proc: E2EProcess,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  const r = await dispatch(tool, args, proc.ctx);
  return {
    ok: !r.isError,
    payload: JSON.parse(r.content[0]!.text) as Record<string, unknown>,
  };
}
