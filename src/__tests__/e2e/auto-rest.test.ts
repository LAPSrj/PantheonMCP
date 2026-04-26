import { test, expect, beforeEach, afterEach } from "bun:test";
import { makeFixture, type E2EFixture } from "./harness.ts";
import { defaultOnDeadline, type Scheduler, type TimerHandle } from "../../watchdog/index.ts";
import { stampRested } from "../../identity/index.ts";

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

test("auto-rest fires after rest_timeout with no qualifying activity", async () => {
  // Register + claim alpha.
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

  // Arm the watchdog with the minimum rest_timeout (3600s).
  fix.procA.ctx.watchdog.register({
    session: fix.procA.ctx.session,
    rest_timeout: 3600,
    onDeadline: (s) => {
      defaultOnDeadline(s);
      if (s.claimedUsername) {
        stampRested(fix.paths, s.claimedUsername, "auto_rest_timeout", null);
      }
    },
  });

  // Advance the fake clock past the deadline without any qualifying
  // activity. The deadline should fire and stamp the registry.
  expect(fix.procA.ctx.session.isResting).toBe(false);
  fakeA.advance(3600 * 1000);
  expect(fix.procA.ctx.session.isResting).toBe(true);

  const { readPersona } = await import("../../identity/index.ts");
  const persona = readPersona(fix.paths, "alpha");
  expect(persona?.rest_reason).toBe("auto_rest_timeout");
  expect(persona?.last_rested_at).not.toBeNull();
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
