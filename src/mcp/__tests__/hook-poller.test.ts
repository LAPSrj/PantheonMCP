import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import {
  HookPoller,
  HOOK_MARKER_FILE,
  readMarkerMtime,
  sessionMarkerDir,
  sessionMarkerPath,
  sweepStaleSessionDirs,
} from "../hook-poller.ts";

let tmpDir: string;
let paths: Paths;
const PPID = 12345;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-hook-poller-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function touchMarker(): string {
  const dir = sessionMarkerDir(paths, PPID);
  fs.mkdirSync(dir, { recursive: true });
  const target = sessionMarkerPath(paths, PPID);
  fs.writeFileSync(target, ""); // empty file, mtime is the signal
  return target;
}

test("sessionMarkerPath: <stateDir>/sessions/<ppid>/last_tool_use_at", () => {
  expect(sessionMarkerPath(paths, PPID)).toBe(
    path.join(paths.sessionsDir, String(PPID), HOOK_MARKER_FILE),
  );
});

test("readMarkerMtime returns null when no marker exists", () => {
  expect(readMarkerMtime(paths, PPID)).toBeNull();
});

test("readMarkerMtime returns mtime when marker exists", () => {
  touchMarker();
  const mtime = readMarkerMtime(paths, PPID);
  expect(typeof mtime).toBe("number");
  expect(mtime).toBeGreaterThan(0);
});

test("HookPoller.poll: no-op when marker absent", () => {
  let touched = 0;
  const watchdog = new Watchdog(realScheduler);
  const session = new Session("s-1", { kind: "claimed_persona", username: "x", resting: false });
  watchdog.register({ session, rest_timeout: 3600, onDeadline: () => { touched++; } });
  const poller = new HookPoller({ paths, watchdog, session_id: session.id, ppid: PPID });
  expect(poller.poll()).toBe(false);
  void touched;
});

test("HookPoller.poll: fires watchdog.touch when marker mtime advances", async () => {
  const watchdog = new Watchdog(realScheduler);
  const session = new Session("s-1", { kind: "claimed_persona", username: "x", resting: false });
  watchdog.register({ session, rest_timeout: 3600, onDeadline: () => {} });
  const beforeRegister = watchdog.inspect("s-1")?.last_activity_at ?? 0;

  // Touch marker AFTER the poller's initial mtime read.
  const poller = new HookPoller({ paths, watchdog, session_id: session.id, ppid: PPID });
  await new Promise((r) => setTimeout(r, 5));
  touchMarker();
  await new Promise((r) => setTimeout(r, 5));

  expect(poller.poll()).toBe(true);
  const afterTouch = watchdog.inspect("s-1")?.last_activity_at ?? 0;
  expect(afterTouch).toBeGreaterThan(beforeRegister);
});

test("HookPoller.poll: subsequent polls without mtime change do not re-fire", async () => {
  const watchdog = new Watchdog(realScheduler);
  const session = new Session("s-1", { kind: "claimed_persona", username: "x", resting: false });
  watchdog.register({ session, rest_timeout: 3600, onDeadline: () => {} });
  const poller = new HookPoller({ paths, watchdog, session_id: session.id, ppid: PPID });
  touchMarker();
  await new Promise((r) => setTimeout(r, 5));
  expect(poller.poll()).toBe(true);
  // Next poll, no new touch.
  expect(poller.poll()).toBe(false);
});

test("sweepStaleSessionDirs removes dirs older than the grace; keeps fresh", () => {
  // Stale dir.
  const stale = path.join(paths.sessionsDir, "old-pid");
  fs.mkdirSync(stale, { recursive: true });
  const staleMarker = path.join(stale, HOOK_MARKER_FILE);
  fs.writeFileSync(staleMarker, "");
  fs.utimesSync(staleMarker, new Date(0), new Date(0));
  // Fresh dir.
  const fresh = sessionMarkerDir(paths, PPID);
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, HOOK_MARKER_FILE), "");

  const removed = sweepStaleSessionDirs(paths);
  expect(removed).toBe(1);
  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(fresh)).toBe(true);
});

test("sweepStaleSessionDirs is non-fatal when sessions dir missing", () => {
  // Don't create paths.sessionsDir.
  expect(sweepStaleSessionDirs(paths)).toBe(0);
});
