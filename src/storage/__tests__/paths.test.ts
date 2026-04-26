import { test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  resolvePaths,
  personaFilePath,
  memoryFilePath,
  personaDir,
  legacyPaths,
  findStrandedLegacy,
  assertNoLegacyLayout,
  LegacyLayoutError,
} from "../paths.ts";

test("resolvePaths defaults to ~/.pantheon root", () => {
  const env = {} as NodeJS.ProcessEnv;
  const p = resolvePaths(env);
  const expected = path.join(os.homedir(), ".pantheon");
  expect(p.root).toBe(expected);
  expect(p.dataDir).toBe(expected);
  expect(p.stateDir).toBe(expected);
  expect(p.personasDir).toBe(path.join(expected, "personas"));
  expect(p.chatDbPath).toBe(path.join(expected, "chat.db"));
  expect(p.windowsRegistryPath).toBe(path.join(expected, "windows.json"));
  expect(p.runtimeDir).toBe(path.join(expected, "runtime"));
  expect(p.sessionsDir).toBe(path.join(expected, "sessions"));
});

test("PANTHEON_HOME redirects the root", () => {
  const env = { PANTHEON_HOME: "/sandbox" } as NodeJS.ProcessEnv;
  const p = resolvePaths(env);
  expect(p.root).toBe("/sandbox");
  expect(p.dataDir).toBe("/sandbox");
  expect(p.stateDir).toBe("/sandbox");
  expect(p.personasDir).toBe("/sandbox/personas");
  expect(p.chatDbPath).toBe("/sandbox/chat.db");
  expect(p.windowsRegistryPath).toBe("/sandbox/windows.json");
  expect(p.runtimeDir).toBe("/sandbox/runtime");
});

test("XDG and PANTHEON_DATA_HOME / PANTHEON_STATE_HOME are NOT honored", () => {
  // The 04-26 consolidation drops these. Only PANTHEON_HOME wins.
  const env = {
    XDG_DATA_HOME: "/xdg/data",
    XDG_STATE_HOME: "/xdg/state",
    PANTHEON_DATA_HOME: "/p/data",
    PANTHEON_STATE_HOME: "/p/state",
    HOME: "/home/x",
  } as NodeJS.ProcessEnv;
  const p = resolvePaths(env);
  // Falls through to <HOME>/.pantheon — none of the legacy split env
  // vars take effect.
  expect(p.root).toBe("/home/x/.pantheon");
});

test("personaFilePath / memoryFilePath / personaDir layout", () => {
  const p = resolvePaths({ PANTHEON_HOME: "/x" } as NodeJS.ProcessEnv);
  expect(personaFilePath(p, "vellumpike")).toBe("/x/personas/vellumpike.json");
  expect(personaDir(p, "vellumpike")).toBe("/x/personas/vellumpike");
  expect(memoryFilePath(p, "vellumpike")).toBe("/x/personas/vellumpike/memory.json");
});

test("legacyPaths returns the old XDG-split locations", () => {
  const env = { HOME: "/home/x" } as NodeJS.ProcessEnv;
  const legacy = legacyPaths(env);
  expect(legacy.dataDir).toBe("/home/x/.local/share/pantheon");
  expect(legacy.stateDir).toBe("/home/x/.local/state/pantheon");
});

test("legacyPaths honors XDG_DATA_HOME / XDG_STATE_HOME for the OLD layout", () => {
  const env = {
    XDG_DATA_HOME: "/xdg/data",
    XDG_STATE_HOME: "/xdg/state",
  } as NodeJS.ProcessEnv;
  const legacy = legacyPaths(env);
  expect(legacy.dataDir).toBe("/xdg/data/pantheon");
  expect(legacy.stateDir).toBe("/xdg/state/pantheon");
});

test("findStrandedLegacy returns null when PANTHEON_HOME is set (test sandbox)", () => {
  const env = { PANTHEON_HOME: "/anywhere" } as NodeJS.ProcessEnv;
  expect(findStrandedLegacy(env)).toBeNull();
});

test("findStrandedLegacy detects populated legacy dirs when new root is empty", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-paths-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  // Empty new root.
  fs.mkdirSync(path.join(home, ".pantheon"));
  // Populated legacy data dir.
  const legacyData = path.join(home, ".local", "share", "pantheon");
  fs.mkdirSync(legacyData, { recursive: true });
  fs.writeFileSync(path.join(legacyData, "chat.db"), "x");
  const env = { HOME: home } as NodeJS.ProcessEnv;
  const stranded = findStrandedLegacy(env);
  expect(stranded).not.toBeNull();
  expect(stranded?.dataDir).toBe(legacyData);
});

test("findStrandedLegacy returns null when new root is populated", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-paths-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  const newRoot = path.join(home, ".pantheon");
  fs.mkdirSync(newRoot);
  fs.writeFileSync(path.join(newRoot, "chat.db"), "x");
  const legacyData = path.join(home, ".local", "share", "pantheon");
  fs.mkdirSync(legacyData, { recursive: true });
  fs.writeFileSync(path.join(legacyData, "chat.db"), "y");
  const env = { HOME: home } as NodeJS.ProcessEnv;
  expect(findStrandedLegacy(env)).toBeNull();
});

test("assertNoLegacyLayout throws LegacyLayoutError with mv recipe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-paths-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  const legacyData = path.join(home, ".local", "share", "pantheon");
  fs.mkdirSync(legacyData, { recursive: true });
  fs.writeFileSync(path.join(legacyData, "chat.db"), "x");
  const env = { HOME: home } as NodeJS.ProcessEnv;
  let caught: unknown;
  try {
    assertNoLegacyLayout(env);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(LegacyLayoutError);
  expect((caught as Error).message).toContain("legacy XDG-split storage");
  expect((caught as Error).message).toContain("mkdir -p");
  expect((caught as Error).message).toContain(legacyData);
});

test("assertNoLegacyLayout is a no-op under PANTHEON_HOME", () => {
  const env = { PANTHEON_HOME: "/sandbox" } as NodeJS.ProcessEnv;
  expect(() => assertNoLegacyLayout(env)).not.toThrow();
});
