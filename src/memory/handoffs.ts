import { listPersonas } from "../identity/index.ts";
import type { Paths } from "../storage/index.ts";
import { mutateStore } from "./store.ts";
import type { HandoffMeta, MemoryEntry } from "./types.ts";

/** §6 MEDIUM idle-handoff slot — TTL constants + sweep. */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_KIND = "handoff";

export function defaultHandoffExpiresAt(now: number = Date.now()): number {
  return now + HANDOFF_TTL_MS;
}

/** Build the standardized handoff entry shape for a `rest({ handoff })`
 * call. Caller passes to `appendEntry`.
 *
 * Handoffs are deliberately NOT `core` — a handoff is an ephemeral
 * continuity note (7-day TTL, auto-faded), not a durable foundational
 * rail. Marking it `core` was core-inflation: it forced handoffs into
 * the Core render tier and the `core_memory` boot payload, where
 * multi-KB session snapshots crowded out actual rules. Handoffs
 * surface on their own via `resume_summary.handoffs` instead. */
export interface HandoffSeed {
  text: string;
  summary: string;
  kind: typeof HANDOFF_KIND;
  expires_at: number;
  handoff?: HandoffMeta;
}

export function buildHandoffSeed(
  forUsername: string,
  text: string,
  now: number = Date.now(),
  summary?: string,
  meta?: HandoffMeta,
): HandoffSeed {
  // A caller-supplied `summary` is the handoff's highlight — it lets a
  // reconnecting agent see what the handoff is ABOUT (in the boot
  // payload's `handoffs` list) without reading the full body. When
  // omitted, fall back to boilerplate naming the recipient + TTL.
  const trimmed = summary?.trim();
  const ttlDays = (HANDOFF_TTL_MS / (24 * 60 * 60 * 1000)).toFixed(0);
  // Drop the structured block entirely when no field is populated, so
  // a bare handoff doesn't carry an empty `handoff: {}`.
  const cleanMeta = meta ? pruneHandoffMeta(meta) : undefined;
  return {
    text,
    summary:
      trimmed && trimmed.length > 0
        ? trimmed
        : `Handoff to ${forUsername} — auto-fades after ${ttlDays} days`,
    kind: HANDOFF_KIND,
    expires_at: defaultHandoffExpiresAt(now),
    ...(cleanMeta ? { handoff: cleanMeta } : {}),
  };
}

/** Strip empty fields from a `HandoffMeta`; return undefined when
 * nothing meaningful is left. */
function pruneHandoffMeta(meta: HandoffMeta): HandoffMeta | undefined {
  const out: HandoffMeta = {};
  if (meta.trust_posture && meta.trust_posture.trim().length > 0) {
    out.trust_posture = meta.trust_posture.trim();
  }
  if (meta.pickup && meta.pickup.length > 0) out.pickup = meta.pickup;
  if (meta.memory_refs && meta.memory_refs.length > 0) {
    out.memory_refs = meta.memory_refs;
  }
  if (meta.prohibitions && meta.prohibitions.length > 0) {
    out.prohibitions = meta.prohibitions;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Daemon-tick sweep: walk all personas; fade ANY active entry whose
 * `expires_at` is in the past. Returns a count of faded entries.
 *
 * Not handoff-specific — handoffs are simply the kind that sets
 * `expires_at` by default. Any entry written with an explicit
 * `expires_at` (via `append_memory`) participates in the same sweep.
 *
 * Status mutation here is acceptable per §4: the auto-fade is the
 * EXPLICIT contract of `expires_at` — the entry carries the timestamp
 * precisely so the daemon can fade it. The §4 "status NEVER
 * auto-mutates" rule is about render-time budget enforcement not
 * modifying status; explicit TTL-driven fades remain the user's
 * intent. The sweep only ever FADES (never forgets), so it is safe
 * even for `core` entries that opted into a TTL. */
export function expireEntries(paths: Paths, now: number = Date.now()): number {
  let total = 0;
  for (const persona of listPersonas(paths)) {
    total += expireEntriesFor(paths, persona.username, now);
  }
  return total;
}

export function expireEntriesFor(
  paths: Paths,
  username: string,
  now: number = Date.now(),
): number {
  let faded = 0;
  mutateStore(paths, username, (store) => {
    let mutated = false;
    const entries: MemoryEntry[] = store.entries.map((entry) => {
      if (
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
