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

/** Per-topic cap on the FADED subsection. Faded ≈ archived; without a cap
 * a topic with many faded entries renders an unbounded summary list every
 * time it's loaded. Beyond this, render the newest-N faded summaries + a
 * "(+M older)" count; the rest are list_memory / find_memory only. */
export const FADED_PER_TOPIC = 5;

/** GLOBAL byte ceiling on a single `load_memory` render's FULL-text
 * sections (orphaned watchers + due reminders + pinned + declared-topic
 * durable bodies + delivered handoffs). Bounds the total so an oversized
 * boot render never gets spilled by the MCP-client harness to a flat
 * tool-results file (the on-disk artifact a subagent could read). The
 * cross-topic FULL accumulation is the dominant unbounded driver — N
 * loaded topics could each contribute TOPIC_FULL_BUDGET_BYTES — so the
 * ceiling is shared across those sections, demoting oldest-first to
 * summary under pressure (render-time only; never mutates status). FULL
 * bodies that don't fit collapse to summary + a loud warning; per-entry
 * full text stays reachable via `recall_memory(id)`.
 *
 * Default 24 KB sits comfortably under typical harness inline caps with
 * headroom for the always-summary band + per-topic notes/faded summaries
 * (each independently bounded). Tunable via `PANTHEON_RENDER_MAX_BYTES`.
 * A non-positive / unparseable value disables the ceiling (Infinity). */
export const RENDER_TOTAL_BUDGET_BYTES = resolveRenderBudget();

function resolveRenderBudget(): number {
  const raw = process.env.PANTHEON_RENDER_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") return 24 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
  return n;
}

export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
