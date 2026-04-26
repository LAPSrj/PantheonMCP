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
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const dataRoot = env.PANTHEON_DATA_HOME ?? env.PANTHEON_HOME ?? path.join(xdgDataHome(env), "pantheon");
  const stateRoot = env.PANTHEON_STATE_HOME ?? env.PANTHEON_HOME ?? path.join(xdgStateHome(env), "pantheon");
  return {
    dataDir: dataRoot,
    stateDir: stateRoot,
    personasDir: path.join(dataRoot, "personas"),
    chatDbPath: path.join(dataRoot, "chat.db"),
    windowsRegistryPath: path.join(stateRoot, "windows.json"),
    daemonSocketPath: path.join(stateRoot, "daemon.sock"),
    daemonPidPath: path.join(stateRoot, "daemon.pid"),
    runtimeDir: path.join(stateRoot, "runtime"),
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
