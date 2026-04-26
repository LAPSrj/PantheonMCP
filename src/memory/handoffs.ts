import { listPersonas } from "../identity/index.ts";
import type { Paths } from "../storage/index.ts";
import { mutateStore } from "./store.ts";
import type { MemoryEntry } from "./types.ts";

/** §6 MEDIUM idle-handoff slot — TTL constants + sweep. */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_KIND = "handoff";

export function defaultHandoffExpiresAt(now: number = Date.now()): number {
  return now + HANDOFF_TTL_MS;
}

/** Build the standardized handoff entry shape for a `rest({ handoff })`
 * call. Caller passes to `appendEntry`. */
export interface HandoffSeed {
  text: string;
  summary: string;
  kind: typeof HANDOFF_KIND;
  core: true;
  expires_at: number;
}

export function buildHandoffSeed(
  forUsername: string,
  text: string,
  now: number = Date.now(),
): HandoffSeed {
  return {
    text,
    summary: `Handoff to ${forUsername} — auto-fades after ${(HANDOFF_TTL_MS / (24 * 60 * 60 * 1000)).toFixed(0)} days`,
    kind: HANDOFF_KIND,
    core: true,
    expires_at: defaultHandoffExpiresAt(now),
  };
}

/** Daemon-tick sweep: walk all personas; fade `kind: "handoff"`
 * entries whose `expires_at` is in the past and `status: "active"`.
 * Returns a count of faded entries.
 *
 * Status mutation here is acceptable per §4: the auto-fade is the
 * EXPLICIT contract of the handoff slot — the entry sets
 * `expires_at` precisely so the daemon can fade it. The §4 "status
 * NEVER auto-mutates" rule is about render-time budget enforcement
 * not modifying status; explicit TTL-driven fades remain the user's
 * intent. */
export function expireHandoffs(paths: Paths, now: number = Date.now()): number {
  let total = 0;
  for (const persona of listPersonas(paths)) {
    total += expireHandoffsFor(paths, persona.username, now);
  }
  return total;
}

export function expireHandoffsFor(
  paths: Paths,
  username: string,
  now: number = Date.now(),
): number {
  let faded = 0;
  mutateStore(paths, username, (store) => {
    let mutated = false;
    const entries: MemoryEntry[] = store.entries.map((entry) => {
      if (
        entry.kind === HANDOFF_KIND &&
        entry.status === "active" &&
        entry.expires_at !== undefined &&
        entry.expires_at < now
      ) {
        mutated = true;
        faded++;
        return { ...entry, status: "faded" };
      }
      return entry;
    });
    if (!mutated) return undefined;
    return { ...store, entries };
  });
  return faded;
}
