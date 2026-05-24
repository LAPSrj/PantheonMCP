import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";
import { type Scheduler, type TimerHandle } from "../../watchdog/index.ts";
import { applyAutoRest } from "../../mcp/handlers/lifecycle.ts";
import { listActive } from "../../chat/presence.ts";

class FakeScheduler implements Scheduler {
  private nowMs = 0;
  private nextId = 1;
  private pending = new Map<number, { fireAt: number; fn: () => void }>();

  now() {
    return this.nowMs;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.pending.set(id, { fireAt: this.nowMs + ms, fn });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.nowMs += ms;
    for (const [id, t] of [...this.pending.entries()]) {
      if (t.fireAt <= this.nowMs) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

let fix: E2EFixture;
let fakeA: FakeScheduler;

beforeEach(() => {
  fakeA = new FakeScheduler();
  fix = makeFixture({ schedulerA: fakeA });
});

afterEach(() => {
  fix.cleanup();
});

test("auto-rest fires after rest_timeout: state flips, persona stamped, chat dropped, SIGTERM scheduled", async () => {
  // Summoned-session marker — applyAutoRest gates on this. Non-
  // summoned (user-owned) sessions short-circuit; the dedicated
  // non-summoned test below covers that path.
  fix.procA.ctx.summoner_username = "beta";

  // Register + claim alpha + log into chat.
  const { transitionRegister } = await import("../../identity/index.ts");
  transitionRegister(
    fix.paths,
    fix.procA.ctx.session,
    {
      username: "alpha",
      project: "pantheon",
      cwd: "/work",
      platform: "linux",
    },
    { claim_after: true },
  );
  const login = await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  const alphaAgentId = login.payload.agent_id as string;

  // Arm the watchdog wired the way the production server wires it
  // (server.ts): the deadline runs applyAutoRest, which handles
  // state transition + stampRested + watchdog teardown + chat
  // presence drop + SIGTERM. Pre-fix this lambda only flipped state
  // — the parent CC process kept running indefinitely after the
  // 60-min rest_timeout fired.
  fix.procA.ctx.watchdog.register({
    session: fix.procA.ctx.session,
    rest_timeout: 3600,
    onDeadline: () => applyAutoRest(fix.procA.ctx),
  });

  // Pre-conditions.
  expect(fix.procA.ctx.session.isResting).toBe(false);
  expect(fix.procA.exitCalls).toEqual([]);
  expect(
    listActive(fix.procA.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === alphaAgentId,
    ),
  ).toBe(true);

  // Advance past the deadline.
  fakeA.advance(3600 * 1000);

  // State flipped.
  expect(fix.procA.ctx.session.isResting).toBe(true);

  // Persona registry stamped.
  const { readPersona } = await import("../../identity/index.ts");
  const persona = readPersona(fix.paths, "alpha");
  expect(persona?.rest_reason).toBe("auto_rest_timeout");
  expect(persona?.last_rested_at).not.toBeNull();

  // Chat presence dropped (peers see the agent leave).
  expect(
    listActive(fix.procA.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === alphaAgentId,
    ),
  ).toBe(false);

  // SIGTERM scheduled — the bug fix. Pre-fix the process leaked.
  expect(fix.procA.exitCalls.length).toBe(1);
  expect(fix.procA.exitCalls[0]!.delay_seconds).toBe(2);
  expect(fix.procA.exitCalls[0]!.reason).toBe("auto_rest");
});

test("auto-rest is a no-op for non-summoned sessions: no SIGTERM, state stays awake, chat presence retained", async () => {
  // Default fixture leaves summoner_username = null — the user-owned
  // (manually-started CC) path. applyAutoRest must short-circuit; the
  // watchdog deadline firing must not SIGTERM the parent CC process
  // out from under the user.
  expect(fix.procA.ctx.summoner_username).toBeNull();

  const { transitionRegister } = await import("../../identity/index.ts");
  transitionRegister(
    fix.paths,
    fix.procA.ctx.session,
    {
      username: "alpha",
      project: "pantheon",
      cwd: "/work",
      platform: "linux",
    },
    { claim_after: true },
  );
  const login = await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  const alphaAgentId = login.payload.agent_id as string;

  fix.procA.ctx.watchdog.register({
    session: fix.procA.ctx.session,
    rest_timeout: 3600,
    onDeadline: () => applyAutoRest(fix.procA.ctx),
  });

  fakeA.advance(3600 * 1000);

  // No teardown ran.
  expect(fix.procA.ctx.session.isResting).toBe(false);
  expect(fix.procA.exitCalls).toEqual([]);
  // Persona was never stamped with auto_rest_timeout.
  const { readPersona } = await import("../../identity/index.ts");
  const persona = readPersona(fix.paths, "alpha");
  expect(persona?.rest_reason ?? null).not.toBe("auto_rest_timeout");
  // Chat presence still there.
  expect(
    listActive(fix.procA.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === alphaAgentId,
    ),
  ).toBe(true);
});

test("auto-rest does NOT fire when qualifying activity touches the watchdog", async () => {
  const { transitionRegister } = await import("../../identity/index.ts");
  transitionRegister(
    fix.paths,
    fix.procA.ctx.session,
    {
      username: "alpha",
      project: "pantheon",
      cwd: "/work",
      platform: "linux",
    },
    { claim_after: true },
  );

  let fired = 0;
  fix.procA.ctx.watchdog.register({
    session: fix.procA.ctx.session,
    rest_timeout: 3600,
    onDeadline: () => {
      fired++;
    },
  });

  // Advance halfway, touch, advance halfway, touch — should never fire.
  for (let i = 0; i < 10; i++) {
    fakeA.advance(1800 * 1000);
    fix.procA.ctx.watchdog.touch(fix.procA.ctx.session.id);
  }
  expect(fired).toBe(0);
  expect(fix.procA.ctx.session.isResting).toBe(false);
});
