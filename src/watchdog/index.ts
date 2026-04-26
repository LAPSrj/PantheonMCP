export {
  Watchdog,
  realScheduler,
  defaultOnDeadline,
  type Scheduler,
  type TimerHandle,
} from "./watchdog.ts";

export {
  type RestTimeout,
  type SessionRegistration,
  type WatchdogState,
  type WatchdogErrorCode,
  WatchdogError,
  DEFAULT_REST_TIMEOUT_SECONDS,
  MIN_REST_TIMEOUT_SECONDS,
} from "./types.ts";

export {
  RESET_TRIGGER_TOOLS,
  NON_RESET_TOOLS,
  isResetTrigger,
} from "./triggers.ts";
