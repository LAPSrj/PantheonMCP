import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? os.homedir();
}

/** §11d storage root resolution.
 *
 * Pantheon stores everything under a single root: `~/.pantheon/`.
 * This is intentionally NOT XDG-compliant — Leandro's call (per
 * 04-26 spec): keep all pantheon state in one folder so it's easy
 * to back up, migrate, sync, or hand-edit. Convention pattern is
 * `~/.ssh/`, `~/.gitconfig`, `~/.cargo/`.
 *
 * Override: `PANTHEON_HOME` redirects the root (used in test
 * sandboxes so suites don't clobber the user's real data). The
 * legacy XDG-split env vars (`PANTHEON_DATA_HOME`,
 * `PANTHEON_STATE_HOME`) and `XDG_DATA_HOME` / `XDG_STATE_HOME`
 * are NOT honored — only `PANTHEON_HOME`.
 *
 * If pantheon detects that the default `~/.pantheon/` is missing
 * but the legacy XDG-split paths still exist, we throw a clear
 * error with a one-line `mv` recipe rather than silently
 * auto-migrating. See `assertNoLegacyLayout`.
 */

export interface Paths {
  /** Root of all pantheon state. Single folder. */
  root: string;
  /** @deprecated Same as `root`. Kept for callers that still
   * read `dataDir`. Will be removed once the consolidation has
   * settled. */
  dataDir: string;
  /** @deprecated Same as `root`. Kept for callers that still
   * read `stateDir`. Will be removed once the consolidation has
   * settled. */
  stateDir: string;
  personasDir: string;
  chatDbPath: string;
  windowsRegistryPath: string;
  daemonSocketPath: string;
  daemonPidPath: string;
  runtimeDir: string;
  /** Per-CC-session marker dir for plugin hooks. Each CC parent
   * process gets `<sessionsDir>/<ppid>/`; hooks `touch` files
   * inside it (e.g. `last_tool_use_at`) and the MCP server's
   * daemon-tick polls them to drive watchdog resets per §14
   * plugin-mode. */
  sessionsDir: string;
  /** Default location of the user's `~/.claude.json` config (the file
   * pantheon writes to auto-trust persona cwds before spawn). When
   * `PANTHEON_HOME` is set (test sandbox), redirects to
   * `<PANTHEON_HOME>/.claude.json` so tests can't clobber the real
   * config. The MCP HandlerContext seeds `claude_config_path` from
   * this field. */
  claudeConfigPath: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const root = env.PANTHEON_HOME ?? path.join(homeOf(env), ".pantheon");
  // PANTHEON_CLAUDE_CONFIG > <PANTHEON_HOME>/.claude.json (test sandbox) > real ~/.claude.json
  const claudeConfigPath =
    env.PANTHEON_CLAUDE_CONFIG ??
    (env.PANTHEON_HOME
      ? path.join(env.PANTHEON_HOME, ".claude.json")
      : path.join(homeOf(env), ".claude.json"));
  return {
    root,
    dataDir: root,
    stateDir: root,
    personasDir: path.join(root, "personas"),
    chatDbPath: path.join(root, "chat.db"),
    windowsRegistryPath: path.join(root, "windows.json"),
    daemonSocketPath: path.join(root, "daemon.sock"),
    daemonPidPath: path.join(root, "daemon.pid"),
    runtimeDir: path.join(root, "runtime"),
    sessionsDir: path.join(root, "sessions"),
    claudeConfigPath,
  };
}

export function personaFilePath(paths: Paths, handle: string): string {
  return path.join(paths.personasDir, `${handle}.json`);
}

export function memoryFilePath(paths: Paths, handle: string): string {
  return path.join(paths.personasDir, handle, "memory.json");
}

export function personaDir(paths: Paths, handle: string): string {
  return path.join(paths.personasDir, handle);
}

export function ensureDataDirs(paths: Paths): void {
  fs.mkdirSync(paths.personasDir, { recursive: true });
}

export function ensureStateDirs(paths: Paths): void {
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
}

export function ensurePersonaDir(paths: Paths, handle: string): void {
  fs.mkdirSync(personaDir(paths, handle), { recursive: true });
}

/** Legacy path layout from before the 04-26 storage consolidation.
 * Returned by `findLegacyPaths` so the error message can list every
 * directory the user needs to merge. */
export interface LegacyLayout {
  dataDir: string;
  stateDir: string;
}

/** Return the legacy XDG-split locations regardless of whether they
 * exist. Pure path computation — no fs touches. */
export function legacyPaths(env: NodeJS.ProcessEnv = process.env): LegacyLayout {
  const xdgData = env.XDG_DATA_HOME ?? path.join(homeOf(env), ".local", "share");
  const xdgState = env.XDG_STATE_HOME ?? path.join(homeOf(env), ".local", "state");
  return {
    dataDir: path.join(xdgData, "pantheon"),
    stateDir: path.join(xdgState, "pantheon"),
  };
}

/** Detect a stranded legacy layout: the new `~/.pantheon/` doesn't
 * exist (or is empty) but one of the old XDG-split dirs has files.
 * Returns the offending paths so the caller can render a useful
 * error. Returns `null` when the layout is fine.
 *
 * Skipped entirely when `PANTHEON_HOME` is set (test sandbox — tests
 * pick their own paths and never touch `~/.local/{share,state}/`). */
export function findStrandedLegacy(
  env: NodeJS.ProcessEnv = process.env,
): LegacyLayout | null {
  if (env.PANTHEON_HOME) return null;
  const newRoot = path.join(homeOf(env), ".pantheon");
  // If the new root is already populated, the user has migrated. We
  // don't care that the old paths might still exist as orphans —
  // that's their cleanup, not ours.
  if (dirHasContent(newRoot)) return null;
  const legacy = legacyPaths(env);
  const legacyData = dirHasContent(legacy.dataDir);
  const legacyState = dirHasContent(legacy.stateDir);
  if (!legacyData && !legacyState) return null;
  return legacy;
}

function dirHasContent(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return false;
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

export class LegacyLayoutError extends Error {
  legacy: LegacyLayout;
  target: string;
  constructor(legacy: LegacyLayout, target: string) {
    const lines = [
      `pantheon: legacy XDG-split storage layout detected.`,
      ``,
      `The old paths still hold pantheon data:`,
      `  ${legacy.dataDir}`,
      `  ${legacy.stateDir}`,
      ``,
      `Pantheon now expects a single folder at ${target}.`,
      `To consolidate, run (in this exact order):`,
      ``,
      `  mkdir -p ${target}`,
      `  mv ${legacy.dataDir}/* ${target}/  2>/dev/null || true`,
      `  mv ${legacy.stateDir}/* ${target}/ 2>/dev/null || true`,
      `  rmdir ${legacy.dataDir} ${legacy.stateDir} 2>/dev/null || true`,
      ``,
      `Then re-run pantheon. (Files won't collide — the two old`,
      `roots held disjoint subdirs: data held personas/ + chat.db,`,
      `state held windows.json + runtime/ + sessions/.)`,
    ];
    super(lines.join("\n"));
    this.name = "LegacyLayoutError";
    this.legacy = legacy;
    this.target = target;
  }
}

/** Throws `LegacyLayoutError` when a stranded legacy layout is
 * found. Callers (CLI subcommands, MCP server startup) invoke this
 * before any `resolvePaths` consumer so the user sees the message
 * before pantheon starts writing to a fresh empty `~/.pantheon/`. */
export function assertNoLegacyLayout(env: NodeJS.ProcessEnv = process.env): void {
  const legacy = findStrandedLegacy(env);
  if (legacy) {
    const target = path.join(homeOf(env), ".pantheon");
    throw new LegacyLayoutError(legacy, target);
  }
}
