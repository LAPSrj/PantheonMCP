import child_process from "node:child_process";
import type { SpawnPlan } from "./types.ts";

/** Injectable shim around `child_process.spawn` so handlers can be
 * unit-tested without actually launching subprocesses. The real
 * executor calls Node's spawn; tests pass a fake executor that
 * captures the call. */
export interface SpawnExecutor {
  spawn(command: string, args: string[], options: NodeSpawnOptions): SpawnedProcess;
}

export interface NodeSpawnOptions {
  env?: Record<string, string>;
  cwd?: string;
  detached: boolean;
  stdio: Array<"pipe" | "ignore" | "inherit">;
}

export interface SpawnedProcess {
  pid?: number | undefined;
  stderr: NodeJS.ReadableStream | null;
  unref(): void;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
}

export const realSpawnExecutor: SpawnExecutor = {
  spawn(command, args, options) {
    const child = child_process.spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      detached: options.detached,
      stdio: options.stdio,
    });
    return child;
  },
};

export interface ExecuteResult {
  pid: number | undefined;
  /** Non-null when the §11a 200ms stderr probe captured anything on a
   * `requires_stderr_probe` plan. The summon handler forwards this
   * verbatim into the MCP response so silent split failures surface. */
  stderr_warning?: string;
}

export interface ExecuteOptions {
  executor?: SpawnExecutor;
  /** Stderr probe duration in ms. Default 200; tests pass shorter values. */
  stderr_probe_ms?: number;
}

/** Run a SpawnPlan: spawn detached, optionally probe stderr for silent
 * failures (per §11a), unref, return pid + any captured stderr. */
export async function executeSpawnPlan(
  plan: SpawnPlan,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const executor = options.executor ?? realSpawnExecutor;
  const probeMs = options.stderr_probe_ms ?? 200;

  const child = executor.spawn(plan.command, plan.args, {
    env: { ...process.env, ...plan.env } as Record<string, string>,
    ...(plan.cwd !== undefined ? { cwd: plan.cwd } : {}),
    detached: true,
    stdio: plan.requires_stderr_probe
      ? ["ignore", "ignore", "pipe"]
      : ["ignore", "ignore", "ignore"],
  });

  let stderr_warning: string | undefined;
  if (plan.requires_stderr_probe && child.stderr) {
    stderr_warning = await captureStderr(child.stderr, probeMs);
  }

  try {
    child.unref();
  } catch {
    // Test executors may not expose unref; ignore.
  }

  const result: ExecuteResult = { pid: child.pid };
  if (stderr_warning !== undefined) result.stderr_warning = stderr_warning;
  return result;
}

function captureStderr(
  stream: NodeJS.ReadableStream,
  probeMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };
    stream.on("data", onData);
    setTimeout(() => {
      stream.off("data", onData);
      const trimmed = buf.trim();
      resolve(trimmed.length > 0 ? trimmed : undefined);
    }, probeMs);
  });
}
