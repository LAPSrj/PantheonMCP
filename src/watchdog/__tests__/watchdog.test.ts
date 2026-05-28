import { test, expect } from "bun:test";
import { Session } from "../../identity/index.ts";
import {
  Watchdog,
  WatchdogError,
  defaultOnDeadline,
  isResetTrigger,
  RESET_TRIGGER_TOOLS,
  type Scheduler,
  type TimerHandle,
} from "../index.ts";

/** Manual scheduler for deterministic timer tests. */
class FakeScheduler implements Scheduler {
  private nowMs = 0;
  private nextId = 1;
  private pending = new Map<number, { fireAt: number; fn: () => void }>();
  /** Sequence of values returned by `random()`. Cycles when exhausted;
   * defaults to a single 0.5 so untested call sites get a stable mid-
   * range value. */
  randomValues: number[] = [0.5];
  private randomCursor = 0;

  now(): number {
    return this.nowMs;
  }

  random(): number {
    const v = this.randomValues[this.randomCursor % this.randomValues.length]!;
    this.randomCursor++;
    return v;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.pending.set(id, { fireAt: this.nowMs + ms, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending.delete(handle as number);
  }

  /** Advance the fake clock by `ms`, firing any timers whose deadline
   * is at or before the new time. Returns the count of fired timers. */
  advance(ms: number): number {
    this.nowMs += ms;
    let fired = 0;
    // Fire in deadline order to simulate real-timer ordering.
    while (true) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.pending) {
        if (t.fireAt <= this.nowMs && t.fireAt < nextAt) {
          nextId = id;
          nextAt = t.fireAt;
        }
      }
      if (nextId === null) break;
      const t = this.pending.get(nextId)!;
      this.pending.delete(nextId);
      t.fn();
      fired++;
    }
    return fired;
  }

  /** Simulate the OS sleeping for `ms` milliseconds: the wallclock
   * advances but no pending timers fire during the sleep itself.
   * `advance()` after this will fire every timer whose original
   * deadline fell within the sleep window — modeling how a real
   * setTimeout behaves on wake. */
  sleep(ms: number): void {
    this.nowMs += ms;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

function claimedSession(id = "s-1"): Session {
  return new Session(id, { kind: "claimed_persona", username: "vellumpike", resting: false });
}

// --- registration + arming ---

test("register arms a timer at rest_timeout seconds", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  const session = claimedSession();
  let fired = 0;
  wd.register({ session, rest_timeout: 3600, onDeadline: () => fired++ });

  expect(fake.pendingCount()).toBe(1);
  expect(wd.inspect(session.id)?.scheduled_for).toBe(3600 * 1000);

  // 59:59 — does not fire.
  fake.advance(3600 * 1000 - 1);
  expect(fired).toBe(0);

  // The remaining 1ms triggers the deadline.
  fake.advance(1);
  expect(fired).toBe(1);
});

test("register with rest_timeout 'never' arms NO timer", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  wd.register({
    session: claimedSession(),
    rest_timeout: "never",
    onDeadline: () => {
      throw new Error("must not fire");
    },
  });
  expect(fake.pendingCount()).toBe(0);
  expect(wd.inspect("s-1")?.scheduled_for).toBeNull();
});

test("register validates minimum rest_timeout (3600s)", () => {
  const wd = new Watchdog(new FakeScheduler());
  let err: unknown;
  try {
    wd.register({
      session: claimedSession(),
      rest_timeout: 3599,
      onDeadline: () => {},
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WatchdogError);
  expect((err as WatchdogError).code).toBe("rest_timeout_too_short");
});

// --- touch / extend ---

test("touch resets the deadline", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  let fired = 0;
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => fired++,
  });

  // 30 min in, touch.
  fake.advance(1800 * 1000);
  wd.touch("s-1");
  expect(wd.inspect("s-1")?.scheduled_for).toBe(1800 * 1000 + 3600 * 1000);

  // 59 more minutes — still under 60 from the touch.
  fake.advance(3540 * 1000);
  expect(fired).toBe(0);

  // 1 more minute crosses the new deadline.
  fake.advance(60 * 1000);
  expect(fired).toBe(1);
});

test("touch under high activity never accumulates timers (no leak)", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  let fired = 0;
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => fired++,
  });

  // 1000 touches in tight succession.
  for (let i = 0; i < 1000; i++) {
    fake.advance(1);
    wd.touch("s-1");
  }
  expect(fake.pendingCount()).toBe(1);
  expect(fired).toBe(0);
});

test("touch on unregistered session is a no-op (no throw)", () => {
  const wd = new Watchdog(new FakeScheduler());
  expect(() => wd.touch("ghost")).not.toThrow();
});

test("extend errors when the session is not registered", () => {
  const wd = new Watchdog(new FakeScheduler());
  let err: unknown;
  try {
    wd.extend("ghost");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WatchdogError);
  expect((err as WatchdogError).code).toBe("session_not_registered");
});

// --- unregister + shutdown ---

test("unregister cancels the pending timer", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  let fired = 0;
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => fired++,
  });
  wd.unregister("s-1");
  expect(fake.pendingCount()).toBe(0);
  fake.advance(3600 * 1000 + 1);
  expect(fired).toBe(0);
});

test("shutdown clears every pending timer", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  for (let i = 1; i <= 5; i++) {
    wd.register({
      session: claimedSession(`s-${i}`),
      rest_timeout: 3600,
      onDeadline: () => {},
    });
  }
  expect(fake.pendingCount()).toBe(5);
  wd.shutdown();
  expect(fake.pendingCount()).toBe(0);
});

// --- setTimeout (rearm with new value) ---

test("setTimeout updates the deadline using the new value", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  let fired = 0;
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => fired++,
  });
  wd.setTimeout("s-1", 7200);
  expect(wd.inspect("s-1")?.scheduled_for).toBe(7200 * 1000);
  fake.advance(3600 * 1000);
  expect(fired).toBe(0);
  fake.advance(3600 * 1000);
  expect(fired).toBe(1);
});

test("setTimeout to 'never' disarms the timer", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => {
      throw new Error("must not fire");
    },
  });
  wd.setTimeout("s-1", "never");
  expect(fake.pendingCount()).toBe(0);
  fake.advance(3600 * 1000 * 100);
});

// --- defaultOnDeadline + transitionRestEnter integration ---

test("defaultOnDeadline flips a claimed session to resting", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  const session = claimedSession();
  wd.register({
    session,
    rest_timeout: 3600,
    onDeadline: defaultOnDeadline,
  });
  fake.advance(3600 * 1000);
  expect(session.isResting).toBe(true);
});

test("defaultOnDeadline is a no-op for an unclaimed session (defensive)", () => {
  const session = new Session("s-1");
  expect(() => defaultOnDeadline(session)).not.toThrow();
});

// --- onDeadline handler that throws does not crash the watchdog ---

test("watchdog swallows onDeadline handler errors", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => {
      throw new Error("boom");
    },
  });
  expect(() => fake.advance(3600 * 1000)).not.toThrow();
});

// --- sleep-wake detection ---

test("timer fired far past deadline rearms with jitter instead of firing onDeadline", () => {
  const fake = new FakeScheduler();
  // r=0 → multiplier = 0.9 → ms = 0.9 * 3600s = 3240s. Above the
  // 3600s MIN_REST_TIMEOUT floor, so the Math.max clamps to 3600s.
  // Use r=0.5 to land squarely inside the jitter window.
  fake.randomValues = [0.5];
  const wd = new Watchdog(fake);
  let fired = 0;
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => fired++,
  });

  // Simulate 8 hours of OS sleep, then deliver pending timers.
  fake.sleep(8 * 3600 * 1000);
  fake.advance(0);

  expect(fired).toBe(0);
  expect(fake.pendingCount()).toBe(1);
  const state = wd.inspect("s-1");
  expect(state).not.toBeNull();
  // last_activity_at was reset to the wake instant.
  expect(state!.last_activity_at).toBe(8 * 3600 * 1000);
  // r=0.5 → multiplier = 1 - 0.1 + 0.5 * (0.1 + 2.0) = 1.95 → ms = 7020s.
  // Deadline = wake + 7020s.
  expect(state!.scheduled_for).toBe(8 * 3600 * 1000 + 7020 * 1000);
});

test("timer fired just slightly late still fires onDeadline normally", () => {
  const fake = new FakeScheduler();
  const wd = new Watchdog(fake);
  let fired = 0;
  wd.register({
    session: claimedSession(),
    rest_timeout: 3600,
    onDeadline: () => fired++,
  });

  // 30s late — well under the 60s/5% threshold (5% of 3600s = 180s,
  // floor 60s → effective threshold 180s for this rest_timeout).
  fake.advance(3600 * 1000 + 30_000);
  expect(fired).toBe(1);
  expect(fake.pendingCount()).toBe(0);
});

test("jitter spreads N agents waking together across the rest_timeout window", () => {
  // Five agents, all armed at t=0 with the default 60-min rest_timeout.
  // Host sleeps 8h, every timer fires immediately on wake. Each agent
  // gets a different random draw, so the rearmed deadlines spread.
  const fake = new FakeScheduler();
  fake.randomValues = [0.0, 0.25, 0.5, 0.75, 1.0]; // one per agent
  const wd = new Watchdog(fake);
  let fired = 0;
  for (let i = 1; i <= 5; i++) {
    wd.register({
      session: claimedSession(`s-${i}`),
      rest_timeout: 3600,
      onDeadline: () => fired++,
    });
  }

  fake.sleep(8 * 3600 * 1000);
  fake.advance(0);

  expect(fired).toBe(0);
  expect(fake.pendingCount()).toBe(5);
  const deadlines = [1, 2, 3, 4, 5]
    .map((i) => wd.inspect(`s-${i}`)!.scheduled_for!)
    .sort((a, b) => a - b);
  // Earliest agent (r=0): multiplier=0.9 → 3240s; clamped UP to the
  // 3600s MIN_REST_TIMEOUT floor. Latest agent (r=1): multiplier=2.9
  // → 10440s. Spread between min and max: at least 1 hour — proves
  // the cohort no longer fires at the same instant.
  const spreadMs = deadlines[deadlines.length - 1]! - deadlines[0]!;
  expect(spreadMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
});

// --- triggers ---

test("RESET_TRIGGER_TOOLS includes the §14 explicit reset list", () => {
  for (const name of [
    "send_message",
    "update_status",
    "ask",
    "answer",
    "append_memory",
    "update_memory",
    "fade_memory",
    "forget_memory",
    "recall_memory",
    "get_memory_details",
    "update_profile",
    "become",
    "claim",
    "manifest",
    "extend_rest",
  ]) {
    expect(RESET_TRIGGER_TOOLS.has(name)).toBe(true);
  }
});

test("isResetTrigger: explicit triggers true, NON_RESET false, unknown defaults true", () => {
  expect(isResetTrigger("send_message")).toBe(true);
  expect(isResetTrigger("check_messages")).toBe(false);
  expect(isResetTrigger("list_agents")).toBe(false);
  expect(isResetTrigger("brand-new-tool")).toBe(true);
});
