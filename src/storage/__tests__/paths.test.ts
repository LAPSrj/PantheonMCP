import { test, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import {
  resolvePaths,
  personaFilePath,
  memoryFilePath,
  personaDir,
} from "../paths.ts";

test("resolvePaths defaults to XDG locations under pantheon/", () => {
  const env = { HOME: "/home/x" } as NodeJS.ProcessEnv;
  const p = resolvePaths(env);
  expect(p.dataDir).toBe(path.join(os.homedir(), ".local", "share", "pantheon"));
  expect(p.stateDir).toBe(path.join(os.homedir(), ".local", "state", "pantheon"));
  expect(p.personasDir).toBe(path.join(p.dataDir, "personas"));
  expect(p.chatDbPath).toBe(path.join(p.dataDir, "chat.db"));
  expect(p.windowsRegistryPath).toBe(path.join(p.stateDir, "windows.json"));
});

test("XDG_DATA_HOME / XDG_STATE_HOME override the defaults", () => {
  const env = {
    XDG_DATA_HOME: "/custom/data",
    XDG_STATE_HOME: "/custom/state",
  } as NodeJS.ProcessEnv;
  const p = resolvePaths(env);
  expect(p.dataDir).toBe("/custom/data/pantheon");
  expect(p.stateDir).toBe("/custom/state/pantheon");
});

test("PANTHEON_HOME overrides both data and state roots", () => {
  const env = { PANTHEON_HOME: "/sandbox" } as NodeJS.ProcessEnv;
  const p = resolvePaths(env);
  expect(p.dataDir).toBe("/sandbox");
  expect(p.stateDir).toBe("/sandbox");
  expect(p.personasDir).toBe("/sandbox/personas");
  expect(p.chatDbPath).toBe("/sandbox/chat.db");
});

test("PANTHEON_DATA_HOME / PANTHEON_STATE_HOME provide split overrides", () => {
  const env = {
    PANTHEON_HOME: "/ignored",
    PANTHEON_DATA_HOME: "/data",
    PANTHEON_STATE_HOME: "/state",
  } as NodeJS.ProcessEnv;
  const p = resolvePaths(env);
  expect(p.dataDir).toBe("/data");
  expect(p.stateDir).toBe("/state");
});

test("personaFilePath / memoryFilePath / personaDir layout", () => {
  const p = resolvePaths({ PANTHEON_HOME: "/x" } as NodeJS.ProcessEnv);
  expect(personaFilePath(p, "vellumpike")).toBe("/x/personas/vellumpike.json");
  expect(personaDir(p, "vellumpike")).toBe("/x/personas/vellumpike");
  expect(memoryFilePath(p, "vellumpike")).toBe("/x/personas/vellumpike/memory.json");
});
