/** §14 watchdog types. */

import type { Session } from "../identity/index.ts";

/** `"never"` disables the auto-rest timer entirely; no timer is armed.
 * Numeric values are seconds; minimum 3600 (60 min) per §14. */
export type RestTimeout = number | "never";

export const DEFAULT_REST_TIMEOUT_SECONDS = 3600;
export const MIN_REST_TIMEOUT_SECONDS = 3600;

export interface SessionRegistration {
  session: Session;
  rest_timeout: RestTimeout;
  /** Called on deadline. The default callback flips the session to
   * resting and stamps `rest_reason: "auto_rest_timeout"` via the
   * registry, but tests can inject anything. */
  onDeadline: (session: Session) => void;
}

export interface WatchdogState {
  rest_timeout: RestTimeout;
  /** ms timestamp of the last qualifying activity (last touch). */
  last_activity_at: number;
  /** ms timestamp the next firing is currently scheduled for, or
   * `null` when no timer is armed (e.g. `rest_timeout: "never"` or
   * the session has already auto-rested and not been reactivated). */
  scheduled_for: number | null;
}

export class WatchdogError extends Error {
  code: WatchdogErrorCode;
  constructor(code: WatchdogErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "WatchdogError";
  }
}

export type WatchdogErrorCode =
  | "session_not_registered"
  | "rest_timeout_too_short"
  | "rest_timeout_invalid";
