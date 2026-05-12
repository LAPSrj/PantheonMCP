import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session, createPersona } from "../../identity/index.ts";
import { Watchdog } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;

class FakeScheduler {
  private nowMs = 0;
  private nextId = 1;
  private pending = new Map<number, { fireAt: number; fn: () => void }>();
  now() {
    return this.nowMs;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.pending.set(id, { fireAt: this.nowMs + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.pending.delete(handle as number);
  }
  advance(ms: number) {
    this.nowMs += ms;
    for (const [id, t] of [...this.pending.entries()]) {
      if (t.fireAt <= this.nowMs) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-vuq-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(new FakeScheduler() as never),
    parent_pid: 99999,
    platform: "linux",
    scheduleExit: () => {},
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; payload: Record<string, unknown> }> {
  const r = await dispatch(tool, args, ctx);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  return { ok: !r.isError, payload };
}

test("validate_user_quote returns unknown_persona for an unregistered username", async () => {
  const r = await call("validate_user_quote", {
    username: "never-existed",
    quote: "anything",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.found).toBe(false);
  expect(r.payload.error).toBe("unknown_persona");
  expect(r.payload.username).toBe("never-existed");
  expect(r.payload.matches).toEqual([]);
});

test("validate_user_quote returns no_sessions when the persona exists but has no transcript dir", async () => {
  // Use a cwd that is highly unlikely to collide with the real
  // ~/.claude/projects layout — the handler reads from the real
  // user home, so the test relies on the encoded cwd NOT existing.
  const unlikelyCwd = path.join(tmpDir, "synthetic-cwd-for-validate-test");
  createPersona(ctx.paths, {
    username: "validate-test-persona",
    project: "pantheon",
    cwd: unlikelyCwd,
    platform: "linux",
  });
  const r = await call("validate_user_quote", {
    username: "validate-test-persona",
    quote: "anything",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.found).toBe(false);
  expect(r.payload.error).toBe("no_sessions");
  expect(r.payload.username).toBe("validate-test-persona");
  expect(r.payload.cwd).toBe(unlikelyCwd);
  expect(r.payload.project).toBe("pantheon");
});

test("validate_user_quote rejects missing username via dispatch", async () => {
  const r = await call("validate_user_quote", { quote: "x" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("validate_user_quote rejects missing quote via dispatch", async () => {
  const r = await call("validate_user_quote", { username: "vellumpike" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("validate_user_quote rejects unknown fields", async () => {
  const r = await call("validate_user_quote", {
    username: "vellumpike",
    quote: "x",
    bogus: 1,
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});
