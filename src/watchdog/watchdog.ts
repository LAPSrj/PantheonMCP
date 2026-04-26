import { Session, transitionRestEnter } from "../identity/index.ts";
import {
  DEFAULT_REST_TIMEOUT_SECONDS,
  MIN_REST_TIMEOUT_SECONDS,
  WatchdogError,
  type RestTimeout,
  type SessionRegistration,
  type WatchdogState,
} from "./types.ts";

/** Indirection over `setTimeout` / `clearTimeout` / `Date.now` so
 * tests can drive the watchdog deterministically without sleeping
 * real wall-clock time. The default exported `realScheduler` uses
 * the host's timers verbatim. */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = unknown;

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface InternalRecord {
  reg: SessionRegistration;
  timer: TimerHandle | null;
  last_activity_at: number;
  scheduled_for: number | null;
  /** Once the deadline fires we set this so subsequent touches that
   * arrive in the same loop tick don't double-fire. The session can
   * still be re-armed via `extend` / `register` again. */
  fired: boolean;
}

/** §14 watchdog. Owns the per-session timers + last-activity stamps.
 * Stateless across daemon restarts — claims are runtime-only per §15;
 * the watchdog rearms on each fresh `register`.
 *
 * Concurrency: every `touch` cancels and re-arms the timer, so a
 * session that's bombarded with activity faster than the timer fires
 * never accumulates timers. The timer-leak guard is enforced by
 * `clearTimeout(prev) → setTimeout(...)` in that order inside
 * `arm()`.
 */
export class Watchdog {
  private readonly scheduler: Scheduler;
  private readonly records = new Map<string, InternalRecord>();

  constructor(scheduler: Scheduler = realScheduler) {
    this.scheduler = scheduler;
  }

  /** Register a session and arm its timer (unless `rest_timeout` is
   * `"never"`). Re-registering an existing session replaces the
   * previous record and timer. */
  register(reg: SessionRegistration): void {
    validateRestTimeout(reg.rest_timeout);
    const prev = this.records.get(reg.session.id);
    if (prev?.timer != null) {
      this.scheduler.clearTimeout(prev.timer);
    }
    const record: InternalRecord = {
      reg,
      timer: null,
      last_activity_at: this.scheduler.now(),
      scheduled_for: null,
      fired: false,
    };
    this.records.set(reg.session.id, record);
    this.arm(record);
  }

  /** Cancel and remove a session. Idempotent. */
  unregister(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    if (record.timer != null) this.scheduler.clearTimeout(record.timer);
    this.records.delete(sessionId);
  }

  /** Mark qualifying activity. Cancels the existing timer (if any)
   * and re-arms with a fresh deadline. No-op for `"never"` sessions
   * and for sessions not registered with the watchdog. */
  touch(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.last_activity_at = this.scheduler.now();
    record.fired = false;
    this.arm(record);
  }

  /** Same effect as `touch` — surfaced separately so handlers and
   * docs can call out the explicit `extend_rest` tool path. */
  extend(sessionId: string): void {
    if (!this.records.has(sessionId)) {
      throw new WatchdogError(
        "session_not_registered",
        `Session '${sessionId}' is not registered with the watchdog.`,
      );
    }
    this.touch(sessionId);
  }

  /** Update a session's `rest_timeout` in place. Re-arms the timer
   * with the new value. */
  setTimeout(sessionId: string, rest_timeout: RestTimeout): void {
    validateRestTimeout(rest_timeout);
    const record = this.records.get(sessionId);
    if (!record) {
      throw new WatchdogError(
        "session_not_registered",
        `Session '${sessionId}' is not registered with the watchdog.`,
      );
    }
    record.reg = { ...record.reg, rest_timeout };
    record.fired = false;
    this.arm(record);
  }

  /** Inspection — public state without exposing the timer handle. */
  inspect(sessionId: string): WatchdogState | null {
    const record = this.records.get(sessionId);
    if (!record) return null;
    return {
      rest_timeout: record.reg.rest_timeout,
      last_activity_at: record.last_activity_at,
      scheduled_for: record.scheduled_for,
    };
  }

  /** Cancel every timer (e.g. daemon shutdown). */
  shutdown(): void {
    for (const record of this.records.values()) {
      if (record.timer != null) this.scheduler.clearTimeout(record.timer);
    }
    this.records.clear();
  }

  private arm(record: InternalRecord): void {
    if (record.timer != null) {
      this.scheduler.clearTimeout(record.timer);
      record.timer = null;
      record.scheduled_for = null;
    }
    if (record.reg.rest_timeout === "never") return;
    const ms = record.reg.rest_timeout * 1000;
    record.scheduled_for = record.last_activity_at + ms;
    record.timer = this.scheduler.setTimeout(() => {
      record.timer = null;
      record.scheduled_for = null;
      record.fired = true;
      try {
        record.reg.onDeadline(record.reg.session);
      } catch {
        // Swallow handler errors — the watchdog must not crash on a
        // misbehaving callback. Production wiring should log via the
        // daemon's structured logger before re-throwing if desired.
      }
    }, ms);
  }
}

function validateRestTimeout(value: RestTimeout): void {
  if (value === "never") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WatchdogError(
      "rest_timeout_invalid",
      `rest_timeout must be a number of seconds or "never"; got ${String(value)}.`,
    );
  }
  if (value < MIN_REST_TIMEOUT_SECONDS) {
    throw new WatchdogError(
      "rest_timeout_too_short",
      `rest_timeout must be at least ${MIN_REST_TIMEOUT_SECONDS}s (60 min). Got ${value}s.`,
    );
  }
}

/** Default `onDeadline` handler — flips the session to resting and
 * sets `rest_reason: "auto_rest_timeout"`. Persisting the rest_reason
 * to the registry (via `stampRested`) is left to the caller; the
 * watchdog itself does not write to disk. */
export function defaultOnDeadline(session: Session): void {
  if (session.state.kind !== "claimed_persona") return;
  transitionRestEnter(session);
}

export { DEFAULT_REST_TIMEOUT_SECONDS };
