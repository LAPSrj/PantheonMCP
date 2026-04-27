/** Stop-hook runtime bridge.
 *
 * Pantheon serve writes a small env file at `~/.pantheon/runtime/
 * env-<claude_session_id>.json` on boot, capturing the
 * `context_thresholds` ladder + the (optional) window override.
 * The Stop hook (`pantheon context-check`) reads it back to drive
 * threshold decisions.
 *
 * Key design point: the file is keyed by the CC session UUID (not
 * the parent pid) so the hook can match what CC passes in its
 * Stop event payload. Pantheon resolves that UUID by reading
 * `~/.claude/sessions/<ppid>.json` at MCP boot — same pattern
 * summon-mcp uses. */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../storage/paths.ts";
import type { ContextThreshold } from "./context-thresholds.ts";

export interface RuntimeEnvFile {
  claude_session_id: string;
  claude_pid: number;
  cwd_at_boot: string;
  context_thresholds: ContextThreshold[];
  context_window_override: number | null;
  written_at: number;
}

export interface FiredFile {
  fired_fractions: number[];
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? os.homedir();
}

const CLAUDE_SESSIONS_DIR = path.join(
  homeOf(process.env),
  ".claude",
  "sessions",
);

/** Read CC's session UUID for a given parent pid. Returns null
 * when the session file is absent (pantheon was launched outside
 * a CC session — fine, the runtime env just won't be written and
 * the Stop hook silently no-ops). */
export function readClaudeSessionId(claudePid: number): string | null {
  try {
    const raw = fs.readFileSync(
      path.join(CLAUDE_SESSIONS_DIR, `${claudePid}.json`),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { sessionId?: string };
    const id = parsed.sessionId?.trim();
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function runtimeEnvPath(paths: Paths, claudeSessionId: string): string {
  return path.join(paths.runtimeDir, `env-${claudeSessionId}.json`);
}

function runtimeFiredPath(paths: Paths, claudeSessionId: string): string {
  return path.join(paths.runtimeDir, `fired-${claudeSessionId}.json`);
}

function ensureRuntimeDir(paths: Paths): void {
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function writeRuntimeEnv(file: RuntimeEnvFile, env: NodeJS.ProcessEnv = process.env): void {
  const paths = resolvePaths(env);
  ensureRuntimeDir(paths);
  atomicWrite(
    runtimeEnvPath(paths, file.claude_session_id),
    JSON.stringify(file, null, 2),
  );
}

export function readRuntimeEnv(
  claudeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeEnvFile | null {
  const paths = resolvePaths(env);
  try {
    const raw = fs.readFileSync(runtimeEnvPath(paths, claudeSessionId), "utf8");
    return JSON.parse(raw) as RuntimeEnvFile;
  } catch {
    return null;
  }
}

export function readFired(
  claudeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const paths = resolvePaths(env);
  try {
    const raw = fs.readFileSync(runtimeFiredPath(paths, claudeSessionId), "utf8");
    const parsed = JSON.parse(raw) as FiredFile;
    return Array.isArray(parsed.fired_fractions) ? parsed.fired_fractions : [];
  } catch {
    return [];
  }
}

export function writeFired(
  claudeSessionId: string,
  firedFractions: number[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const paths = resolvePaths(env);
  ensureRuntimeDir(paths);
  atomicWrite(
    runtimeFiredPath(paths, claudeSessionId),
    JSON.stringify({ fired_fractions: firedFractions }, null, 2),
  );
}

export function deleteRuntimeFiles(
  claudeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const paths = resolvePaths(env);
  for (const p of [
    runtimeEnvPath(paths, claudeSessionId),
    runtimeFiredPath(paths, claudeSessionId),
  ]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // best effort
    }
  }
}

export function sweepRuntimeDir(
  activeSessionIds: Set<string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const paths = resolvePaths(env);
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.runtimeDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const m = entry.match(/^(?:env|fired)-(.+)\.json$/);
    if (!m) continue;
    const sessionId = m[1]!;
    if (activeSessionIds.has(sessionId)) continue;
    try {
      fs.unlinkSync(path.join(paths.runtimeDir, entry));
    } catch {
      // best effort
    }
  }
}

const HOOK_MARKER = "pantheon:context-check";

/** Generate the bash wrapper script that the user's Stop hook
 * invokes. Fast-path: skip the bun spawn when this CC session has
 * no pantheon runtime file (i.e. pantheon wasn't connected to this
 * session). Idempotent — call from MCP boot to keep it in sync.
 *
 * The wrapper is keyed off `PANTHEON_HOME` (set in test sandboxes)
 * with a fallback to `$HOME/.pantheon`. Mirrors summon's pattern. */
export function ensureStopHookWrapper(
  env: NodeJS.ProcessEnv = process.env,
): { wrapperPath: string; binPath: string } {
  const paths = resolvePaths(env);
  const wrapperPath = path.join(paths.root, "context-check-wrapper.sh");
  // The wrapper invokes `bun /path/to/pantheon.ts context-check`.
  // We resolve the bin path from this module's location so the
  // wrapper always points at the active pantheon checkout.
  const binPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..", "..", "bin", "pantheon.ts",
  );
  const script = `#!/usr/bin/env bash
# ${HOOK_MARKER} — fast path: skip bun spawn when this Claude
# session has no pantheon runtime file. Generated by pantheon serve
# at MCP boot. Edit src/cli/runtime-bridge.ts to change.
set -e
input=$(cat)
session_id=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)
if [ -z "$session_id" ]; then
  printf '{}'
  exit 0
fi
runtime_dir="\${PANTHEON_HOME:-$HOME/.pantheon}/runtime"
if [ ! -f "$runtime_dir/env-$session_id.json" ]; then
  printf '{}'
  exit 0
fi
printf '%s' "$input" | exec bun ${binPath} context-check
`;
  ensureRuntimeDir(paths);
  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  return { wrapperPath, binPath };
}
