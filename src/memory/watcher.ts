/** Watcher-kind engine (`docs/memory-redesign/6-watcher-kind.md`).
 *
 * Two operations beyond plain memory writes:
 *   - `claimWatcher` — the atomic re-arm claim. A conditional-mutator
 *     compare-and-swap over `mutateStore`'s fingerprint-guarded
 *     mutate-then-rename: re-bind the owner to the claimant ONLY IF the
 *     current owner is still orphaned (absent from the live presence
 *     set). Concurrent siblings can't both win — the loser's retry
 *     re-reads the winner's write and its condition turns false.
 *   - `sweepOrphanedWatchers` — the daemon-tick fast path. Flags newly
 *     orphaned watchers (owner left presence) so the caller can push a
 *     re-arm notification exactly once, deduped across siblings by the
 *     `orphan_notified` flag (the reminder `notified` analog).
 *
 * Orphaned-ness is NEVER a stored status — it's derived live from the
 * presence set at render time (`isWatcherOrphaned`) and at sweep time
 * here. `orphan_notified` is push-dedup metadata, not state.
 */

import type { Paths } from "../storage/index.ts";
import { mutateStore } from "./store.ts";
import { mapLegacyKind } from "./taxonomy.ts";
import type { MemoryEntry } from "./types.ts";

export type ClaimReason =
  | "won"
  | "not_found"
  | "not_watcher"
  | "not_orphaned";

export interface ClaimResult {
  won: boolean;
  reason: ClaimReason;
  /** The re-bound entry, when `won`. */
  entry?: MemoryEntry;
  /** The current (live) owner agent_id, when lost to `not_orphaned`. */
  owner_agent_id?: string;
}

/** Atomic re-arm claim. `claimantAgentId` is the claiming session's live
 * chat agent_id (`ctx.chat_agent_id`); `liveAgentIds` is the presence
 * snapshot (`ChatRouter.liveAgentIds()`). On win, re-binds
 * `owner_agent_id` to the claimant, stamps `last_rearmed_at`, and clears
 * `orphan_notified` so a subsequent death re-orphans + re-notifies. */
export function claimWatcher(
  paths: Paths,
  username: string,
  id: string,
  claimantAgentId: string,
  liveAgentIds: Set<string>,
  now: number,
): ClaimResult {
  let result: ClaimResult = { won: false, reason: "not_found" };
  mutateStore(paths, username, (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx < 0) {
      result = { won: false, reason: "not_found" };
      return undefined;
    }
    const e = store.entries[idx]!;
    if (mapLegacyKind(e.kind) !== "watcher" || !e.watcher) {
      result = { won: false, reason: "not_watcher" };
      return undefined;
    }
    const ownerId = e.watcher.owner_agent_id;
    // CAS condition: claim ONLY IF the current owner is orphaned. If the
    // owner is live — never orphaned, or a sibling already won and
    // re-bound to its own live id — we lose. The fingerprint guard makes
    // this race-safe: the loser's retry re-reads the winner's owner and
    // this branch turns false.
    if (liveAgentIds.has(ownerId)) {
      result = { won: false, reason: "not_orphaned", owner_agent_id: ownerId };
      return undefined;
    }
    const next: MemoryEntry = {
      ...e,
      watcher: {
        ...e.watcher,
        owner_agent_id: claimantAgentId,
        last_rearmed_at: now,
        orphan_notified: false,
      },
    };
    const entries = store.entries.slice();
    entries[idx] = next;
    result = { won: true, reason: "won", entry: next };
    return { ...store, entries };
  });
  return result;
}

/** Daemon-tick sweep: flag active watcher entries whose arming session
 * has left `liveAgentIds` and that haven't been pushed yet. Returns the
 * newly-flagged entries so the caller can push one notification each.
 * Mirrors `sweepDueReminders`; the `orphan_notified` flag dedups across
 * sibling processes (whoever's mutate lands first sets it; the rest
 * re-read it set and skip). */
export function sweepOrphanedWatchers(
  paths: Paths,
  username: string,
  liveAgentIds: Set<string>,
  _now: number,
): MemoryEntry[] {
  const newly: MemoryEntry[] = [];
  mutateStore(paths, username, (store) => {
    let changed = false;
    const entries = store.entries.map((e) => {
      if (e.status !== "active") return e;
      if (mapLegacyKind(e.kind) !== "watcher" || !e.watcher) return e;
      if (e.watcher.orphan_notified) return e; // already pushed
      if (liveAgentIds.has(e.watcher.owner_agent_id)) return e; // owner live
      changed = true;
      const next: MemoryEntry = {
        ...e,
        watcher: { ...e.watcher, orphan_notified: true },
      };
      newly.push(next);
      return next;
    });
    if (!changed) return undefined;
    return { ...store, entries };
  });
  return newly;
}
