/** Redesign-v2 decay engine (`5-proposal-v2.md` §8 / §10 / §14).
 *
 * Session/topic-based decay is evaluated at the session boundary
 * (`load_memory`), NOT on a clock — topic-gating makes unloaded entries
 * free, so there's no disuse timer. This module is the load-time pass:
 *
 *   - Handoff matching-session fade (§8): A = loaded topics, H = the
 *     handoff's topic. A∩H=∅ → frozen (not delivered). A=={H} → consume
 *     after this one session. A∩H≠∅, A≠{H} → matched++ (once per
 *     session, deduped by session_seq), fade at matched==3. A faded
 *     handoff → forgotten on the next matching session.
 *   - Next-session reminders (§10): a reminder due "next-session" that
 *     was created in an earlier session has now been delivered → fade it
 *     so it doesn't re-fire.
 *
 * The pass runs AFTER `load_memory` has rendered, so the entries being
 * consumed are still shown in the session that consumes them.
 */

import type { Paths } from "../storage/index.ts";
import { mutateStore } from "./store.ts";
import { entryTopic, mapLegacyKind } from "./taxonomy.ts";
import type { MemoryEntry, MemoryStore } from "./types.ts";

/** §8 — fade threshold for partially-matching handoffs. */
export const HANDOFF_MATCH_THRESHOLD = 3;

export interface DecaySummary {
  handoffs_faded: string[];
  handoffs_forgotten: string[];
  handoffs_advanced: string[];
  reminders_faded: string[];
}

/** Apply the load-time decay pass for a session. `loadedTopics` is the
 * set declared via `load_memory` this session; `sessionSeq` is this
 * conversation's ordinal (from `beginSession`). Mutates the store. */
export function decayOnLoad(
  paths: Paths,
  username: string,
  loadedTopics: string[],
  sessionSeq: number,
): DecaySummary {
  const summary: DecaySummary = {
    handoffs_faded: [],
    handoffs_forgotten: [],
    handoffs_advanced: [],
    reminders_faded: [],
  };
  const loaded = new Set(loadedTopics);

  mutateStore(paths, username, (store) => {
    let changed = false;
    const entries = store.entries.map((e) => {
      const next = stepEntry(e, loaded, sessionSeq, summary);
      if (next !== e) changed = true;
      return next;
    });
    if (!changed) return undefined;
    return { ...store, entries };
  });

  return summary;
}

function stepEntry(
  e: MemoryEntry,
  loaded: Set<string>,
  sessionSeq: number,
  summary: DecaySummary,
): MemoryEntry {
  if (e.status === "forgotten") return e;
  const kind = mapLegacyKind(e.kind);

  if (kind === "handoff") return stepHandoff(e, loaded, sessionSeq, summary);
  if (kind === "reminder") return stepReminder(e, sessionSeq, summary);
  return e;
}

function stepHandoff(
  e: MemoryEntry,
  loaded: Set<string>,
  sessionSeq: number,
  summary: DecaySummary,
): MemoryEntry {
  const topic = entryTopic(e);
  // Handoffs require a topic; an un-topiced one can't match → frozen.
  if (topic === null) return e;
  const matching = loaded.has(topic);
  if (!matching) return e; // A∩H=∅ → frozen, never expires unseen.

  // Faded handoff on a matching session → forgotten.
  if (e.status === "faded") {
    summary.handoffs_forgotten.push(e.id);
    return { ...e, status: "forgotten" };
  }

  // A == {H} exactly (loaded only this handoff's topic) → consume now.
  const exact = loaded.size === 1 && loaded.has(topic);
  if (exact) {
    summary.handoffs_faded.push(e.id);
    return { ...e, status: "faded" };
  }

  // A∩H≠∅, A≠{H} → advance matched once per session.
  if (e.last_matched_seq === sessionSeq) return e; // already counted this session
  const matched = (e.matched ?? 0) + 1;
  if (matched >= HANDOFF_MATCH_THRESHOLD) {
    summary.handoffs_faded.push(e.id);
    return { ...e, matched, last_matched_seq: sessionSeq, status: "faded" };
  }
  summary.handoffs_advanced.push(e.id);
  return { ...e, matched, last_matched_seq: sessionSeq };
}

function stepReminder(
  e: MemoryEntry,
  sessionSeq: number,
  summary: DecaySummary,
): MemoryEntry {
  // A next-session reminder created in an earlier session has now been
  // delivered (this session > its creation seq) → fade it.
  if (e.due !== "next-session") return e;
  if (e.session_seq === undefined) return e; // unknown creation seq — leave it
  if (sessionSeq > e.session_seq && e.status === "active") {
    summary.reminders_faded.push(e.id);
    return { ...e, status: "faded" };
  }
  return e;
}

/** Mark date-reminders whose due instant has passed as notified, used by
 * the daemon-tick to push exactly once. Returns the entries that newly
 * crossed their due instant (so the caller can push notifications). */
export function sweepDueReminders(
  paths: Paths,
  username: string,
  now: number,
): MemoryEntry[] {
  const newlyDue: MemoryEntry[] = [];
  mutateStore(paths, username, (store: MemoryStore) => {
    let changed = false;
    const entries = store.entries.map((e) => {
      if (e.status !== "active") return e;
      if (mapLegacyKind(e.kind) !== "reminder") return e;
      if (typeof e.due !== "number") return e;
      if (e.due > now) return e;
      if (e.notified) return e;
      changed = true;
      newlyDue.push(e);
      return { ...e, notified: true };
    });
    if (!changed) return undefined;
    return { ...store, entries };
  });
  return newlyDue;
}
