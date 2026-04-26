import fs from "node:fs";
import path from "node:path";
import type { Paths } from "../storage/index.ts";
import type { Watchdog } from "../watchdog/index.ts";

/** §14 plugin-mode watchdog reset wiring.
 *
 * The PreToolUse hook (`plugin/hooks/watchdog-reset.sh`) `touch`es
 * `~/.pantheon/sessions/<ppid>/last_tool_use_at` on every CC
 * tool-use. This module is the daemon-tick consumer: it
 * stats the marker; if the mtime advanced since the last check, it
 * calls `watchdog.touch(session_id)`.
 *
 * Why PPID instead of CC's session_id:
 *   - The hook has $PPID (always set, always = CC's pid).
 *   - The MCP server has process.ppid (same value).
 *   - Both can derive the marker path with no CC-session-file
 *     parsing — simpler and version-stable.
 *   - Multiple MCP servers in the same CC session share the
 *     marker, but each only resets ITS OWN watchdog session id —
 *     no cross-talk. */

export const HOOK_MARKER_FILE = "last_tool_use_at";
export const STALE_SESSION_DIR_MS = 60 * 60 * 1000;

export function sessionMarkerDir(paths: Paths, ppid: number): string {
  return path.join(paths.sessionsDir, String(ppid));
}

export function sessionMarkerPath(paths: Paths, ppid: number): string {
  return path.join(sessionMarkerDir(paths, ppid), HOOK_MARKER_FILE);
}

/** Returns the mtime of the marker file in ms, or `null` if missing.
 * Used by the daemon-tick to detect fresh hook fires. */
export function readMarkerMtime(paths: Paths, ppid: number): number | null {
  try {
    return fs.statSync(sessionMarkerPath(paths, ppid)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Stateful marker poller. Tracks the last mtime we saw; when the
 * file is newer, calls `watchdog.touch(session_id)`. Idempotent —
 * call as often as you like (5s in production). */
export class HookPoller {
  private readonly paths: Paths;
  private readonly watchdog: Watchdog;
  private readonly sessionId: string;
  private readonly ppid: number;
  private lastMtime: number;

  constructor(args: {
    paths: Paths;
    watchdog: Watchdog;
    session_id: string;
    ppid: number;
    /** Optional initial mtime; defaults to current marker mtime
     * (so we don't fire on the first poll for an existing
     * stale marker). */
    initial_mtime?: number;
  }) {
    this.paths = args.paths;
    this.watchdog = args.watchdog;
    this.sessionId = args.session_id;
    this.ppid = args.ppid;
    this.lastMtime =
      args.initial_mtime ?? readMarkerMtime(this.paths, this.ppid) ?? 0;
  }

  /** Poll once. Returns true when a fresh marker triggered a touch. */
  poll(): boolean {
    const mtime = readMarkerMtime(this.paths, this.ppid);
    if (mtime === null) return false;
    if (mtime <= this.lastMtime) return false;
    this.lastMtime = mtime;
    try {
      this.watchdog.touch(this.sessionId);
    } catch {
      // best-effort — never let a poll crash the daemon
    }
    return true;
  }
}

/** Boot-time housekeeping: delete `<sessionsDir>/<ppid>/` dirs that
 * are stale (no tool-use marker fresher than `stale_after_ms`).
 * Non-fatal — failures don't block daemon boot. */
export function sweepStaleSessionDirs(
  paths: Paths,
  options: { now?: number; stale_after_ms?: number } = {},
): number {
  const now = options.now ?? Date.now();
  const staleAfter = options.stale_after_ms ?? STALE_SESSION_DIR_MS;
  let removed = 0;
  try {
    if (!fs.existsSync(paths.sessionsDir)) return 0;
    for (const name of fs.readdirSync(paths.sessionsDir)) {
      const dir = path.join(paths.sessionsDir, name);
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) continue;
        const markerPath = path.join(dir, HOOK_MARKER_FILE);
        let lastTouch = stat.mtimeMs;
        try {
          lastTouch = fs.statSync(markerPath).mtimeMs;
        } catch {
          // marker absent → use dir mtime
        }
        if (now - lastTouch > staleAfter) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // best-effort — skip unreadable entries
      }
    }
  } catch {
    // sessionsDir missing or unreadable; nothing to do
  }
  return removed;
}
