/** Redesign-v2 byte budgets (`5-proposal-v2.md` §5–§6). Two symmetric
 * every-session surfaces, both bounded by construction:
 *
 *   - PINNED (full text)      — rendered FULL every session, regardless
 *                               of topic. A pin that would push the
 *                               always-FULL set over budget is rejected
 *                               (`pin_budget_exceeded`).
 *   - `always` (summaries)    — rendered as SUMMARY every session. An
 *                               `always` entry that would push the band
 *                               over budget is rejected
 *                               (`always_budget_exceeded`).
 *
 * Render demotes oldest-first within these budgets; validation rejects
 * the write that would breach them. Same numbers drive both so the
 * "reject → consolidate" guard and the render ladder stay consistent.
 */

/** Full-text byte budget for the pinned (always-FULL) set. Inherits the
 * legacy Core 10 KB cap — pins are v2's replacement for `core`. */
export const PIN_FULL_BUDGET_BYTES = 10 * 1024;

/** Summary-text byte budget for the `always`-topic band. Summaries are
 * ≤240 chars, so 8 KB admits ~34 always-loaded entries before the guard
 * forces consolidation. */
export const ALWAYS_SUMMARY_BUDGET_BYTES = 8 * 1024;

/** Per-topic FULL-text budget for a declared (loaded) topic. Beyond
 * this the oldest active entries in that topic collapse to summary at
 * render time (never mutated — render-time only). */
export const TOPIC_FULL_BUDGET_BYTES = 8 * 1024;

/** §6 — notes render as title+summary, last-N per topic; older notes are
 * search/list-only. */
export const NOTES_PER_TOPIC = 5;

export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
