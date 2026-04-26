import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function xdgDataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

function xdgStateHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}

export interface Paths {
  dataDir: string;
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
  const dataRoot = env.PANTHEON_DATA_HOME ?? env.PANTHEON_HOME ?? path.join(xdgDataHome(env), "pantheon");
  const stateRoot = env.PANTHEON_STATE_HOME ?? env.PANTHEON_HOME ?? path.join(xdgStateHome(env), "pantheon");
  // PANTHEON_CLAUDE_CONFIG > <PANTHEON_HOME>/.claude.json (test sandbox) > real ~/.claude.json
  const claudeConfigPath =
    env.PANTHEON_CLAUDE_CONFIG ??
    (env.PANTHEON_HOME
      ? path.join(env.PANTHEON_HOME, ".claude.json")
      : path.join(os.homedir(), ".claude.json"));
  return {
    dataDir: dataRoot,
    stateDir: stateRoot,
    personasDir: path.join(dataRoot, "personas"),
    chatDbPath: path.join(dataRoot, "chat.db"),
    windowsRegistryPath: path.join(stateRoot, "windows.json"),
    daemonSocketPath: path.join(stateRoot, "daemon.sock"),
    daemonPidPath: path.join(stateRoot, "daemon.pid"),
    runtimeDir: path.join(stateRoot, "runtime"),
    sessionsDir: path.join(stateRoot, "sessions"),
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
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
}

export function ensurePersonaDir(paths: Paths, handle: string): void {
  fs.mkdirSync(personaDir(paths, handle), { recursive: true });
}
