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
let exitCalls: { delay: number; reason: string }[];

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-handlers-"));
  exitCalls = [];
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(new FakeScheduler() as never),
    parent_pid: 99999,
    platform: "linux",
    scheduleExit: (delay, reason) => exitCalls.push({ delay, reason }),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(tool: string, args: Record<string, unknown> = {}): Promise<{
  ok: boolean;
  payload: Record<string, unknown>;
}> {
  const r = await dispatch(tool, args, ctx);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  return { ok: !r.isError, payload };
}

// --- identity lifecycle ---

test("register → claim flips session to claimed_persona; identity-leak fix is the default", async () => {
  const reg = await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
  });
  expect(reg.ok).toBe(true);
  expect(reg.payload.claimed).toBe(false);
  // Session unchanged because claim_after defaulted to false.
  expect(ctx.session.claimedUsername).toBeNull();

  const claim = await call("claim", { username: "vellumpike" });
  expect(claim.ok).toBe(true);
  expect(ctx.session.claimedUsername).toBe("vellumpike");
});

test("register with claim_after: true flips session", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  expect(ctx.session.claimedUsername).toBe("vellumpike");
});

test("manifest auto-claims on a sole cwd match", async () => {
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/auto",
    platform: "linux",
  });
  const r = await call("manifest", { cwd: "/auto" });
  expect(r.ok).toBe(true);
  expect(r.payload.reason).toBe("sole-match");
  expect(ctx.session.claimedUsername).toBe("vellumpike");
});

test("become flips identity; not_registered leaves session unchanged", async () => {
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/a",
    platform: "linux",
  });
  createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "pantheon",
    cwd: "/b",
    platform: "linux",
  });
  await call("claim", { username: "vellumpike" });
  const become = await call("become", { username: "moth-whistle" });
  expect(become.ok).toBe(true);
  expect(ctx.session.claimedUsername).toBe("moth-whistle");

  const ghost = await call("become", { username: "ghost" });
  expect(ghost.ok).toBe(false);
  expect(ghost.payload.error).toBe("not_registered");
  expect(ctx.session.claimedUsername).toBe("moth-whistle");
});

test("update_profile clears provisional once description+expertise+owns are all set", async () => {
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
    provisional: true,
  });
  await call("claim", { username: "vellumpike" });
  const r = await call("update_profile", {
    description: "lead implementer",
    expertise: ["bun", "ts"],
    owns: ["/work"],
  });
  expect(r.ok).toBe(true);
  expect(r.payload.provisional).toBe(false);
});

test("session_info reports current state", async () => {
  const r = await call("session_info");
  expect(r.ok).toBe(true);
  expect(r.payload.session_id).toBe("test-session");
  expect(r.payload.parent_pid).toBe(99999);
  expect(r.payload.platform).toBe("linux");
  expect(r.payload.state).toBe("unclaimed");
  expect(r.payload.allow_rest_authorized).toBe(false);
});

// --- memory ---

test("append_memory rejects without a claimed persona", async () => {
  const r = await call("append_memory", { text: "x" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("no_persona");
});

test("append_memory + get_memory + recall_memory round-trip", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const append = await call("append_memory", {
    text: "Decision: use bun:sqlite for chat history.",
    kind: "decision",
    core: true,
  });
  expect(append.ok).toBe(true);
  const id = append.payload.id as string;

  const get = await call("get_memory");
  expect(get.ok).toBe(true);
  expect(get.payload.text).toContain("Decision: use bun:sqlite");

  await call("fade_memory", { id });
  const list = await call("list_memory", { status: "faded" });
  expect((list.payload.entries as unknown[])).toHaveLength(1);

  const recalled = await call("recall_memory", { id });
  expect(recalled.ok).toBe(true);
  expect(recalled.payload.status).toBe("active");
});

test("append_memory respects 5MB details cap", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const tooBig = "a".repeat(5 * 1024 * 1024 + 1);
  const r = await call("append_memory", { text: "x", details: tooBig });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("entry_too_large");
});

test("get_memory_details returns ONLY the details field", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const append = await call("append_memory", {
    text: "body",
    details: "verbatim quote",
  });
  const r = await call("get_memory_details", { id: append.payload.id });
  expect(r.ok).toBe(true);
  expect(r.payload.details).toBe("verbatim quote");
  expect(r.payload).not.toHaveProperty("text");
  expect(r.payload).not.toHaveProperty("summary");
});

// --- lifecycle ---

test("rest requires either summoned session or allow_rest", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const denied = await call("rest");
  expect(denied.ok).toBe(false);
  expect(denied.payload.error).toBe("rest_not_authorized");

  await call("allow_rest");
  const ok = await call("rest", { reason: "user_done" });
  expect(ok.ok).toBe(true);
  expect(ctx.session.isResting).toBe(true);
});

test("extend_rest reasons about minimum 60min and rearms watchdog", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  ctx.watchdog.register({
    session: ctx.session,
    rest_timeout: 3600,
    onDeadline: () => {},
  });

  const tooShort = await call("extend_rest", { minutes: 0 });
  expect(tooShort.ok).toBe(false);
  expect(tooShort.payload.error).toBe("invalid_argument");

  const ok = await call("extend_rest", { minutes: 90 });
  expect(ok.ok).toBe(true);
  expect(ok.payload.rest_timeout_seconds).toBe(5400);
});

test("legacy idle aliases delegate and surface a deprecation note", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  await call("allow_idle");
  const r = await call("idle", { reason: "test" });
  expect(r.ok).toBe(true);
  expect(r.payload.deprecation).toContain("rest");
});

test("exit schedules SIGTERM with the requested delay", async () => {
  const r = await call("exit", { delay_seconds: 5 });
  expect(r.ok).toBe(true);
  expect(exitCalls).toEqual([{ delay: 5, reason: "explicit_exit" }]);
});

// --- stub surface ---

test("chat tool errors chat_unavailable when no router attached to context", async () => {
  const r = await call("send_message", { text: "x" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("chat_unavailable");
});

test("summon errors not_registered when target persona doesn't exist", async () => {
  const r = await call("summon", { username: "ghost" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("not_registered");
});
