import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ensureStopHookWrapper,
  readFired,
  readRuntimeEnv,
  writeFired,
  writeRuntimeEnv,
} from "../runtime-bridge.ts";

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-runtime-"));
  env = { ...process.env, PANTHEON_HOME: tmp };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("writeRuntimeEnv + readRuntimeEnv round-trip", () => {
  writeRuntimeEnv(
    {
      claude_session_id: "abc-123",
      claude_pid: 9999,
      cwd_at_boot: "/work",
      context_thresholds: [{ fraction: 0.7, block: false }],
      context_window_override: null,
      written_at: 1_700_000_000,
    },
    env,
  );
  const back = readRuntimeEnv("abc-123", env);
  expect(back).not.toBeNull();
  expect(back!.claude_session_id).toBe("abc-123");
  expect(back!.context_thresholds).toEqual([{ fraction: 0.7, block: false }]);
  expect(back!.cwd_at_boot).toBe("/work");
});

test("readRuntimeEnv: missing file → null", () => {
  expect(readRuntimeEnv("nope", env)).toBeNull();
});

test("writeFired + readFired round-trip", () => {
  writeFired("sid", [0.5, 0.7], env);
  expect(readFired("sid", env)).toEqual([0.5, 0.7]);
});

test("readFired: missing file → empty array", () => {
  expect(readFired("nope", env)).toEqual([]);
});

test("ensureStopHookWrapper writes a 0755 bash script keyed off PANTHEON_HOME", () => {
  const { wrapperPath, binPath } = ensureStopHookWrapper(env);
  expect(wrapperPath).toBe(path.join(tmp, "context-check-wrapper.sh"));
  // bin path resolves to the active checkout's bin/pantheon.ts
  expect(binPath).toMatch(/bin\/pantheon\.ts$/);
  const stat = fs.statSync(wrapperPath);
  // owner-execute bit must be set
  expect(stat.mode & 0o100).toBe(0o100);
  const body = fs.readFileSync(wrapperPath, "utf8");
  expect(body).toMatch(/^#!\/usr\/bin\/env bash/);
  expect(body).toContain("pantheon:context-check");
  expect(body).toContain("PANTHEON_HOME");
  expect(body).toContain("context-check");
  // The wrapper runs the bin via bun, not node
  expect(body).toContain(`exec bun ${binPath} context-check`);
});

test("ensureStopHookWrapper is idempotent (re-call overwrites cleanly)", () => {
  ensureStopHookWrapper(env);
  ensureStopHookWrapper(env);
  // No throw, file still exists
  const wrapperPath = path.join(tmp, "context-check-wrapper.sh");
  expect(fs.existsSync(wrapperPath)).toBe(true);
});
