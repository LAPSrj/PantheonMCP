import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session, createPersona } from "../../identity/index.ts";
import { Watchdog } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { appendEntry } from "../../memory/operations.ts";
import { expireEntries } from "../../memory/index.ts";
import { buildResumeSummary } from "../../resume/index.ts";
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

test("manifest returns core_memory with full text for core entries", async () => {
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/auto",
    platform: "linux",
  });
  appendEntry(ctx.paths, "vellumpike", {
    summary: "the rail",
    text: "full core body",
    core: true,
  });
  appendEntry(ctx.paths, "vellumpike", { summary: "note", text: "ephemeral" });
  const r = await call("manifest", { cwd: "/auto" });
  expect(r.ok).toBe(true);
  const coreMemory = r.payload.core_memory as Array<Record<string, unknown>>;
  expect(coreMemory).toHaveLength(1);
  expect(coreMemory[0]).toMatchObject({
    summary: "the rail",
    text: "full core body",
  });
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

test("update_profile persists permission_mode and round-trips via readPersona", async () => {
  createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
    description: "x",
    expertise: ["x"],
    owns: ["/x"],
  });
  await call("claim", { username: "moth-whistle" });
  const r = await call("update_profile", { permission_mode: "plan" });
  expect(r.ok).toBe(true);
  expect(r.payload.permission_mode).toBe("plan");
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "moth-whistle")?.permission_mode).toBe("plan");
});

test("update_profile permission_mode: null clears the field", async () => {
  createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
    description: "x",
    expertise: ["x"],
    owns: ["/x"],
    permission_mode: "plan",
  });
  await call("claim", { username: "moth-whistle" });
  const r = await call("update_profile", { permission_mode: null });
  expect(r.ok).toBe(true);
  expect(r.payload.permission_mode).toBeNull();
});

test("update_profile persists effort and round-trips; null clears it", async () => {
  createPersona(ctx.paths, {
    username: "moth-whistle", project: "pantheon", cwd: "/work", platform: "linux",
    description: "x", expertise: ["x"], owns: ["/x"],
  });
  await call("claim", { username: "moth-whistle" });
  const set = await call("update_profile", { effort: "high" });
  expect(set.ok).toBe(true);
  expect(set.payload.effort).toBe("high");
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "moth-whistle")?.effort).toBe("high");

  const cleared = await call("update_profile", { effort: null });
  expect(cleared.ok).toBe(true);
  expect(cleared.payload.effort).toBeNull();
});

test("update_profile silently ignores an out-of-enum effort (mirrors permission_mode)", async () => {
  // The update_profile field is `oneOf: [enum, null]`; the dispatcher's
  // JSON-Schema subset doesn't deep-validate oneOf branches, so the
  // handler is the guard — it only persists a recognized level, making a
  // bad value a no-op rather than a hard reject. Same contract as
  // permission_mode. (A per-call summon effort IS hard-rejected — that
  // field is a bare enum, not oneOf — see spawn.test.ts.)
  createPersona(ctx.paths, {
    username: "moth-whistle", project: "pantheon", cwd: "/work", platform: "linux",
    description: "x", expertise: ["x"], owns: ["/x"], effort: "low",
  });
  await call("claim", { username: "moth-whistle" });
  const r = await call("update_profile", { effort: "ludicrous" });
  expect(r.ok).toBe(true);
  const { readPersona } = await import("../../identity/index.ts");
  // Unchanged — the bad value was ignored, the prior default preserved.
  expect(readPersona(ctx.paths, "moth-whistle")?.effort).toBe("low");
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
    topic: "architecture",
    pin: true,
    pin_reason: "foundational architecture decision",
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

test("append_memory persists expires_at; the sweep fades it once past", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const append = await call("append_memory", {
    text: "branch note — good until the PR merges",
    kind: "log",
    expires_at: 1_000,
    verbose: true,
  });
  expect(append.ok).toBe(true);
  expect(append.payload.expires_at).toBe(1_000);
  // Sweep with a now well past the TTL — the entry fades.
  expireEntries(ctx.paths, 9_999_999_999_999);
  const faded = buildResumeSummary(ctx.paths, "vellumpike");
  expect(faded.active_memory_count).toBe(0);
});

test("append_memory: kind:handoff auto-gets a 7-day TTL when expires_at omitted", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const before = Date.now();
  const r = await call("append_memory", { text: "handoff body", kind: "handoff", topic: "work" });
  expect(r.ok).toBe(true);
  expect((r.payload.derived as { expires_at: number }).expires_at).toBeGreaterThan(before);
});

test("append_memory: expires_at:null opts a handoff out of auto-TTL", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const r = await call("append_memory", {
    text: "permanent handoff",
    kind: "handoff",
    topic: "work",
    expires_at: null,
  });
  expect(r.ok).toBe(true);
  expect(r.payload.expires_at).toBeUndefined();
});

test("append_memory: non-handoff without expires_at gets no TTL", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const r = await call("append_memory", { text: "a fact", kind: "fact", topic: "work" });
  expect(r.ok).toBe(true);
  expect(r.payload.expires_at).toBeUndefined();
});

test("append_memory: handoff hints about fading when other handoffs exist", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const first = await call("append_memory", { text: "h1", kind: "handoff", topic: "work" });
  expect(first.payload.hint).toBeUndefined(); // no prior handoffs
  const second = await call("append_memory", { text: "h2", kind: "handoff", topic: "work" });
  expect(second.payload.hint as string).toContain("1 other active handoff");
});

test("append_memory rejects the removed `details` input (v2 §16 hard-cut)", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const r = await call("append_memory", { text: "x", details: "anything" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("get_memory_details returns ONLY the details field", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  // `details` is no longer a write-tool input (v2 §16 hard-cut); legacy
  // entries can still carry it, so seed one via the data layer.
  const append = appendEntry(ctx.paths, "vellumpike", {
    text: "body",
    details: "verbatim quote",
  });
  const r = await call("get_memory_details", { id: append.id });
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

test("rest auto-stamps resume_session_id from ctx.claude_session_id when caller omits it", async () => {
  // Build a fresh ctx with a known CC session UUID so we can assert
  // the auto-capture path.
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  const ctx2 = createContext({
    paths,
    session: new Session("s2"),
    watchdog: new Watchdog(new FakeScheduler() as never),
    parent_pid: 99999,
    platform: "linux",
    scheduleExit: (delay, reason) => exitCalls.push({ delay, reason }),
    claude_session_id: "cc-uuid-abc-123",
  });
  await dispatch(
    "register",
    {
      username: "vellumpike",
      project: "pantheon",
      cwd: "/work",
      claim_after: true,
    },
    ctx2,
  );
  await dispatch("allow_rest", {}, ctx2);
  await dispatch("rest", { reason: "user_done" }, ctx2);
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(paths, "vellumpike")?.resume_session_id).toBe("cc-uuid-abc-123");
});

test("rest: explicit args.session_id overrides ctx.claude_session_id", async () => {
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  const ctx2 = createContext({
    paths,
    session: new Session("s2"),
    watchdog: new Watchdog(new FakeScheduler() as never),
    parent_pid: 99999,
    platform: "linux",
    scheduleExit: (delay, reason) => exitCalls.push({ delay, reason }),
    claude_session_id: "ctx-default",
  });
  await dispatch(
    "register",
    {
      username: "vellumpike",
      project: "pantheon",
      cwd: "/work",
      claim_after: true,
    },
    ctx2,
  );
  await dispatch("allow_rest", {}, ctx2);
  await dispatch(
    "rest",
    { reason: "user_done", session_id: "explicit-override" },
    ctx2,
  );
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(paths, "vellumpike")?.resume_session_id).toBe("explicit-override");
});

test("rest: leaves resume_session_id null when neither arg nor ctx provides one", async () => {
  // ctx (the default in beforeEach) has no claude_session_id, so the
  // cascade falls through to null and stampRested skips the field.
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  await call("allow_rest");
  await call("rest", { reason: "user_done" });
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "vellumpike")?.resume_session_id).toBeNull();
});

test("rest handoff: supersedes fades the named prior handoffs", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  const old1 = appendEntry(ctx.paths, "vellumpike", {
    summary: "old handoff 1",
    text: "x",
    kind: "handoff",
  });
  const old2 = appendEntry(ctx.paths, "vellumpike", {
    summary: "old handoff 2",
    text: "y",
    kind: "handoff",
  });
  await call("allow_rest");
  const r = await call("rest", {
    reason: "user_done",
    handoff: {
      for: "vellumpike",
      text: "new handoff body",
      summary: "picking up where old1 left off",
      supersedes: [old1.id],
    },
  });
  expect(r.ok).toBe(true);
  expect(r.payload.superseded_handoffs).toEqual([old1.id]);
  const h = buildResumeSummary(ctx.paths, "vellumpike").handoffs;
  // old1 faded out; old2 + the new handoff remain active.
  expect(h.map((e) => e.id).sort()).toEqual(
    [old2.id, r.payload.handoff_entry_id as string].sort(),
  );
});

test("rest handoff: supersede_prior fades every other active handoff", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  appendEntry(ctx.paths, "vellumpike", {
    summary: "old A",
    text: "x",
    kind: "handoff",
  });
  appendEntry(ctx.paths, "vellumpike", {
    summary: "old B",
    text: "y",
    kind: "handoff",
  });
  await call("allow_rest");
  const r = await call("rest", {
    reason: "user_done",
    handoff: {
      for: "vellumpike",
      text: "fresh start",
      supersede_prior: true,
    },
  });
  expect(r.ok).toBe(true);
  expect((r.payload.superseded_handoffs as string[]).length).toBe(2);
  const h = buildResumeSummary(ctx.paths, "vellumpike").handoffs;
  // Only the new handoff survives.
  expect(h.map((e) => e.id)).toEqual([r.payload.handoff_entry_id as string]);
});

test("rest handoff: structured fields surface in the next boot payload", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  await call("allow_rest");
  const r = await call("rest", {
    reason: "user_done",
    handoff: {
      for: "vellumpike",
      text: "prose body — in-flight threads and lessons",
      trust_posture: "audit rigor stays full",
      pickup: ["login", "get_memory", "status-check the fleet"],
      memory_refs: [{ id: "some-rule", why: "the commit-auth scope" }],
      prohibitions: ["don't push without a verbatim quote"],
    },
  });
  expect(r.ok).toBe(true);
  const h = buildResumeSummary(ctx.paths, "vellumpike").handoffs[0];
  expect(h?.handoff).toEqual({
    trust_posture: "audit rigor stays full",
    pickup: ["login", "get_memory", "status-check the fleet"],
    memory_refs: [{ id: "some-rule", why: "the commit-auth scope" }],
    prohibitions: ["don't push without a verbatim quote"],
  });
});

test("rest handoff: a handoff with no structured fields carries no handoff block", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    claim_after: true,
  });
  await call("allow_rest");
  await call("rest", {
    reason: "user_done",
    handoff: { for: "vellumpike", text: "just prose" },
  });
  const h = buildResumeSummary(ctx.paths, "vellumpike").handoffs[0];
  expect(h?.handoff).toBeUndefined();
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

test("extend_rest with minutes:'never' disarms the watchdog", async () => {
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

  const r = await call("extend_rest", { minutes: "never" });
  expect(r.ok).toBe(true);
  expect(r.payload.rest_timeout).toBe("never");
  expect(r.payload.rest_timeout_seconds).toBeUndefined();
  const state = ctx.watchdog.inspect(ctx.session.id);
  expect(state?.rest_timeout).toBe("never");
  expect(state?.scheduled_for).toBeNull();
});

test("extend_rest rejects other string values", async () => {
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

  const r = await call("extend_rest", { minutes: "forever" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_argument");
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

// --- §6 LOW only_core filter on get_memory ---

test("get_memory: only_core: true renders ONLY the Core tier (no Active/Index/Hidden sections)", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    description: "lead",
    expertise: ["x"],
    owns: ["/work"],
  });
  await call("claim", { username: "vellumpike" });
  // A pinned entry renders as PINNED; an untyped note lands in the
  // implicit (untopiced) bucket.
  await call("append_memory", { text: "core fact", pin: true, pin_reason: "always visible" });
  await call("append_memory", { text: "active note" });
  const all = await call("get_memory", {});
  expect(all.payload.text).toContain("PINNED");
  expect(all.payload.text).toContain("(untopiced)");
  const coreOnly = await call("get_memory", { only_core: true });
  expect(coreOnly.payload.text).toContain("PINNED");
  expect(coreOnly.payload.text).not.toContain("(untopiced)");
  expect(coreOnly.payload.text).toContain("core fact");
  expect(coreOnly.payload.text).not.toContain("active note");
});

// --- §6 LOW find_memory cross-agent ---

test("find_memory: scope='self' filters the caller's own memory", async () => {
  await call("register", {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    description: "lead",
    expertise: ["x"],
    owns: ["/work"],
  });
  await call("claim", { username: "vellumpike" });
  await call("append_memory", { text: "alpha-keyword fact" });
  await call("append_memory", { text: "unrelated note" });
  const r = await call("find_memory", { query: "alpha-keyword" });
  expect(r.payload.count).toBe(1);
  const hits = r.payload.hits as Array<{ username: string; summary: string }>;
  expect(hits[0]!.username).toBe("vellumpike");
  expect(hits[0]!.summary).toContain("alpha-keyword");
});

test("find_memory rejects a cross-persona `scope` arg (self-only)", async () => {
  await call("register", {
    username: "vellumpike", project: "pantheon", cwd: "/work",
    description: "lead", expertise: ["x"], owns: ["/work"],
  });
  await call("claim", { username: "vellumpike" });
  const r = await call("find_memory", { query: "x", scope: "all" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("find_memory_any walks every persona and attaches username", async () => {
  // Two registered personas, each with one matching entry.
  createPersona(ctx.paths, {
    username: "alpha",
    project: "p",
    cwd: "/a",
    platform: "linux",
    description: "x", expertise: ["x"], owns: ["/a"],
  });
  createPersona(ctx.paths, {
    username: "beta",
    project: "p",
    cwd: "/b",
    platform: "linux",
    description: "y", expertise: ["y"], owns: ["/b"],
  });
  // Seed memory for each by claiming + appending.
  await call("claim", { username: "alpha" });
  await call("append_memory", { text: "shared-keyword from alpha" });
  await call("claim", { username: "beta" });
  await call("append_memory", { text: "shared-keyword from beta" });
  await call("append_memory", { text: "noise" });
  const r = await call("find_memory_any", { query: "shared-keyword" });
  expect(r.payload.count).toBe(2);
  const usernames = (r.payload.hits as Array<{ username: string }>)
    .map((h) => h.username).sort();
  expect(usernames).toEqual(["alpha", "beta"]);
});

test("find_memory: without a claim → no_persona", async () => {
  // No claim; should error (self-only, needs a claimed persona).
  const r = await call("find_memory", { query: "anything" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("no_persona");
});

// --- personal memory is self-only; cross-persona reads are `_any` ---

test("get_memory rejects a cross-persona `username` arg", async () => {
  createPersona(ctx.paths, {
    username: "peerpersona", project: "p", cwd: "/peer", platform: "linux",
    description: "x", expertise: ["x"], owns: ["/peer"],
  });
  await call("register", {
    username: "vellumpike", project: "pantheon", cwd: "/work",
    description: "lead", expertise: ["x"], owns: ["/work"],
  });
  await call("claim", { username: "vellumpike" });
  const r = await call("get_memory", { username: "peerpersona" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("get_memory_any renders another persona's memory", async () => {
  createPersona(ctx.paths, {
    username: "peerpersona", project: "p", cwd: "/peer", platform: "linux",
    description: "x", expertise: ["x"], owns: ["/peer"],
  });
  await call("claim", { username: "peerpersona" });
  await call("append_memory", {
    text: "Peer pinned rule body.",
    summary_max240: "peer-pin-rule",
    kind: "rule",
    topic: "conventions",
    pin: true,
    pin_reason: "always visible",
  });
  // A different caller reads the peer via the elevated _any tool.
  await call("register", {
    username: "vellumpike", project: "pantheon", cwd: "/work",
    description: "lead", expertise: ["x"], owns: ["/work"],
  });
  await call("claim", { username: "vellumpike" });
  const r = await call("get_memory_any", { username: "peerpersona" });
  expect(r.ok).toBe(true);
  expect(r.payload.username).toBe("peerpersona");
  expect(r.payload.text).toContain("Peer pinned rule body.");
});

test("recall_memory_any reads a peer entry WITHOUT mutating its status", async () => {
  // Seed a peer with a faded entry.
  await call("register", {
    username: "peerpersona", project: "p", cwd: "/peer",
    description: "x", expertise: ["x"], owns: ["/peer"],
  });
  await call("claim", { username: "peerpersona" });
  const appended = await call("append_memory", {
    text: "Peer faded body text.",
    summary_max240: "peer-faded-entry",
  });
  const entryId = (appended.payload as { id: string }).id;
  await call("fade_memory", { id: entryId }); // self-fade on the peer

  // Switch to a different caller and recall the peer's faded entry.
  await call("register", {
    username: "vellumpike", project: "pantheon", cwd: "/work",
    description: "lead", expertise: ["x"], owns: ["/work"],
  });
  await call("claim", { username: "vellumpike" });
  const recalled = await call("recall_memory_any", {
    username: "peerpersona",
    id: entryId,
  });
  expect(recalled.ok).toBe(true);
  expect(recalled.payload.text).toBe("Peer faded body text.");
  // Read-only: the peer's entry must STILL be faded (not flipped active).
  expect(recalled.payload.status).toBe("faded");
  const listed = await call("list_memory_any", { username: "peerpersona", status: "all" });
  const entry = (listed.payload.entries as Array<{ id: string; status: string }>)
    .find((e) => e.id === entryId)!;
  expect(entry.status).toBe("faded");
});

// --- §6 HIGH context-pressure nudge surfaces in tool responses ---

test("context-pressure: tool calls past the soft threshold inject a hint into the response", async () => {
  // Bump just past the soft threshold via env override so the test
  // doesn't have to dispatch 50 tools. Also disable the freshness
  // floor — it would otherwise suppress the hint because lastSaveAt
  // is sub-second in test time.
  const prev = process.env.PANTHEON_PRESSURE_SOFT_TOOLS;
  const prevFloor = process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN;
  process.env.PANTHEON_PRESSURE_SOFT_TOOLS = "2";
  process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN = "0";
  try {
    await call("register", {
      username: "vellumpike",
      project: "pantheon",
      cwd: "/work",
      description: "lead", expertise: ["x"], owns: ["/work"],
    });
    await call("claim", { username: "vellumpike" });
    // append_memory IS a save — resets the counter. Run two
    // non-save tools next to cross the soft threshold.
    await call("append_memory", { text: "anchor" });
    await call("session_info");
    const r = await call("session_info");
    const hints = r.payload.hints as string[] | undefined;
    expect(hints).toBeDefined();
    expect(hints!.some((h) => h.includes("context_pressure"))).toBe(true);
    expect(hints!.some((h) => h.includes("soft hint"))).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_PRESSURE_SOFT_TOOLS;
    else process.env.PANTHEON_PRESSURE_SOFT_TOOLS = prev;
    if (prevFloor === undefined) {
      delete process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN;
    } else {
      process.env.PANTHEON_PRESSURE_FRESHNESS_FLOOR_MIN = prevFloor;
    }
  }
});

test("context-pressure: a memory save resets the counter; the next call surfaces no hint", async () => {
  const prev = process.env.PANTHEON_PRESSURE_SOFT_TOOLS;
  process.env.PANTHEON_PRESSURE_SOFT_TOOLS = "2";
  try {
    await call("register", {
      username: "vellumpike", project: "pantheon", cwd: "/work",
      description: "lead", expertise: ["x"], owns: ["/work"],
    });
    await call("claim", { username: "vellumpike" });
    await call("session_info");
    await call("session_info"); // tools = 4 by now (register + claim count too)
    // append_memory resets.
    await call("append_memory", { text: "save" });
    const r = await call("session_info");
    const hints = (r.payload.hints as string[] | undefined) ?? [];
    expect(hints.some((h) => h.includes("context_pressure"))).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_PRESSURE_SOFT_TOOLS;
    else process.env.PANTHEON_PRESSURE_SOFT_TOOLS = prev;
  }
});

// --- WSL distro write-time validation (register / conjure / update_profile) ---

/** A ctx whose spawn_env declares the installed WSL distros via the
 * `PANTHEON_WSL_DISTROS` seam, so validation is deterministic and never
 * shells out to the host's real `wsl.exe`. */
function wslSeamCtx(installed: string): HandlerContext {
  return createContext({
    paths: ctx.paths,
    session: ctx.session,
    watchdog: ctx.watchdog,
    parent_pid: 99999,
    platform: "wsl",
    spawn_env: { PANTHEON_WSL_DISTROS: installed } as NodeJS.ProcessEnv,
  });
}

test("register: a pinned wsl_distro that isn't installed is rejected", async () => {
  const c = wslSeamCtx("Ubuntu-22.04,Debian");
  const r = await dispatch(
    "register",
    { username: "wslpike", project: "pantheon", cwd: "/w", platform: "wsl", wsl_distro: "Ubuntu" },
    c,
  );
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(r.isError).toBe(true);
  expect(payload.error).toBe("wsl_distro_not_found");
  expect((payload.installed as string[])).toEqual(["Ubuntu-22.04", "Debian"]);
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "wslpike")).toBeNull();
});

test("register: an installed wsl_distro is accepted; omitting it is allowed (no longer required)", async () => {
  const c = wslSeamCtx("Ubuntu-22.04,Debian");
  const ok = await dispatch(
    "register",
    { username: "wslpike", project: "pantheon", cwd: "/w", platform: "wsl", wsl_distro: "Ubuntu-22.04" },
    c,
  );
  expect(ok.isError).toBeFalsy();

  const omitted = await dispatch(
    "register",
    { username: "barepike", project: "pantheon", cwd: "/w2", platform: "wsl" },
    c,
  );
  expect(omitted.isError).toBeFalsy();
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "barepike")?.wsl_distro).toBeUndefined();
});

test("update_profile: corrects a bad wsl_distro to an installed one", async () => {
  // Seed a persona carrying the bad value directly (as a hand-edit / legacy
  // entry would), then fix it through the supported API.
  createPersona(ctx.paths, {
    username: "fixpike", project: "pantheon", cwd: "/w", platform: "wsl",
    wsl_distro: "Ubuntu", description: "d", expertise: ["x"], owns: ["/w"],
  });
  const c = wslSeamCtx("Ubuntu-22.04,Debian");
  const r = await dispatch(
    "update_profile",
    { username: "fixpike", wsl_distro: "Ubuntu-22.04" },
    c,
  );
  expect(r.isError).toBeFalsy();
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "fixpike")?.wsl_distro).toBe("Ubuntu-22.04");
});

test("update_profile: rejects setting wsl_distro to a non-existent distro", async () => {
  createPersona(ctx.paths, {
    username: "fixpike", project: "pantheon", cwd: "/w", platform: "wsl",
    wsl_distro: "Ubuntu-22.04", description: "d", expertise: ["x"], owns: ["/w"],
  });
  const c = wslSeamCtx("Ubuntu-22.04,Debian");
  const r = await dispatch(
    "update_profile",
    { username: "fixpike", wsl_distro: "Mint" },
    c,
  );
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(r.isError).toBe(true);
  expect(payload.error).toBe("wsl_distro_not_found");
  // Unchanged.
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "fixpike")?.wsl_distro).toBe("Ubuntu-22.04");
});

test("update_profile: wsl_distro:null clears the field (revert to env inheritance)", async () => {
  createPersona(ctx.paths, {
    username: "fixpike", project: "pantheon", cwd: "/w", platform: "wsl",
    wsl_distro: "Ubuntu-22.04", description: "d", expertise: ["x"], owns: ["/w"],
  });
  const c = wslSeamCtx("Ubuntu-22.04,Debian");
  const r = await dispatch(
    "update_profile",
    { username: "fixpike", wsl_distro: null },
    c,
  );
  expect(r.isError).toBeFalsy();
  const { readPersona } = await import("../../identity/index.ts");
  expect(readPersona(ctx.paths, "fixpike")?.wsl_distro).toBeNull();
});
