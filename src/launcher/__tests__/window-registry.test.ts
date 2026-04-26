import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  getWindowState,
  loadRegistry,
  predictNextTabIndex,
  predictPaneCount,
  recordExit,
  recordSpawn,
} from "../window-registry.ts";

let tmpDir: string;
let paths: Paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-winreg-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("loadRegistry returns empty registry when file absent", () => {
  expect(loadRegistry(paths)).toEqual({ version: 1, windows: {} });
});

test("recordSpawn appends to history and increments tabCount", () => {
  recordSpawn(paths, "summon-vellumpike", {
    summoner: "leandro",
    persona: "vellumpike",
  });
  recordSpawn(paths, "summon-vellumpike", {
    summoner: "leandro",
    persona: "vellumpike",
    tab_index: 1,
  });
  const state = getWindowState(paths, "summon-vellumpike");
  expect(state?.tabCount).toBe(2);
  expect(state?.tabSpawnHistory).toHaveLength(2);
  expect(state?.tabSpawnHistory[1]?.tab_index).toBe(1);
  expect(typeof state?.tabSpawnHistory[0]?.when).toBe("number");
});

test("predictNextTabIndex matches the current tabCount", () => {
  expect(predictNextTabIndex(paths, "fresh")).toBe(0);
  recordSpawn(paths, "fresh", { summoner: null, persona: "x" });
  expect(predictNextTabIndex(paths, "fresh")).toBe(1);
});

test("recordSpawn isolates per-window state", () => {
  recordSpawn(paths, "win-a", { summoner: null, persona: "a" });
  recordSpawn(paths, "win-b", { summoner: null, persona: "b" });
  recordSpawn(paths, "win-b", { summoner: null, persona: "c" });
  expect(getWindowState(paths, "win-a")?.tabCount).toBe(1);
  expect(getWindowState(paths, "win-b")?.tabCount).toBe(2);
});

test("registry survives a re-load (atomic-rename persistence)", () => {
  recordSpawn(paths, "win", { summoner: null, persona: "v" });
  const reloaded = loadRegistry(paths);
  expect(reloaded.windows.win?.tabCount).toBe(1);
});

test("recordExit decrements tabCount but preserves history", () => {
  recordSpawn(paths, "win", { summoner: null, persona: "a" });
  recordSpawn(paths, "win", { summoner: null, persona: "b" });
  expect(getWindowState(paths, "win")?.tabCount).toBe(2);

  recordExit(paths, "win");
  const after = getWindowState(paths, "win");
  expect(after?.tabCount).toBe(1);
  // Audit history retained.
  expect(after?.tabSpawnHistory).toHaveLength(2);
});

test("predictPaneCount returns 0 for unknown windows / tabs", () => {
  expect(predictPaneCount(paths, "ghost", 0)).toBe(0);
});

test("recordSpawn (mode 'new-tab') seeds panesByTab[tab_index] = 1", () => {
  recordSpawn(paths, "win", { summoner: null, persona: "a", mode: "new-tab" });
  expect(predictPaneCount(paths, "win", 0)).toBe(1);
});

test("recordSpawn (mode 'split-pane') increments the target tab's pane count", () => {
  recordSpawn(paths, "win", { summoner: null, persona: "a", mode: "new-tab" });
  recordSpawn(paths, "win", {
    summoner: null,
    persona: "b",
    mode: "split-pane",
    tab_index: 0,
  });
  expect(predictPaneCount(paths, "win", 0)).toBe(2);
  recordSpawn(paths, "win", {
    summoner: null,
    persona: "c",
    mode: "split-pane",
    tab_index: 0,
  });
  expect(predictPaneCount(paths, "win", 0)).toBe(3);
});

test("recordSpawn tracks per-tab pane counts independently", () => {
  recordSpawn(paths, "win", { summoner: null, persona: "a", mode: "new-tab", tab_index: 0 });
  recordSpawn(paths, "win", { summoner: null, persona: "b", mode: "new-tab", tab_index: 1 });
  recordSpawn(paths, "win", {
    summoner: null,
    persona: "c",
    mode: "split-pane",
    tab_index: 0,
  });
  expect(predictPaneCount(paths, "win", 0)).toBe(2);
  expect(predictPaneCount(paths, "win", 1)).toBe(1);
});

test("recordExit clamps tabCount at 0 and is a no-op for unknown windows", () => {
  recordSpawn(paths, "win", { summoner: null, persona: "a" });
  recordExit(paths, "win");
  recordExit(paths, "win"); // already 0, should not go negative
  expect(getWindowState(paths, "win")?.tabCount).toBe(0);

  expect(recordExit(paths, "ghost-window")).toBeNull();
});
