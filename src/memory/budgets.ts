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

/** TIER 1 — shared byte budget on a single render's FULL-TEXT sections
 * (orphaned watchers + due reminders + pinned + declared-topic durable
 * bodies + delivered handoffs). The cross-topic FULL accumulation is the
 * dominant unbounded driver — N loaded topics could each contribute
 * TOPIC_FULL_BUDGET_BYTES — so this ceiling is shared across those
 * sections, demoting oldest-first to summary under pressure (render-time
 * only; never mutates status). FULL bodies that don't fit collapse to
 * summary + a loud warning; per-entry full text stays reachable via
 * `recall_memory(id)`.
 *
 * This bounds FULL BODIES only. The whole-output guarantee (summaries,
 * notes, faded, menu, headers included) is TIER 2 below. Default 24 KB;
 * tunable via `PANTHEON_RENDER_MAX_BYTES`. A non-positive / unparseable
 * value disables it (Infinity). */
export const RENDER_FULLTEXT_BUDGET_BYTES = resolveBudgetEnv(
  "PANTHEON_RENDER_MAX_BYTES",
  24 * 1024,
);

/** TIER 2 — HARD ceiling on the ENTIRE rendered `load_memory` output:
 * every section, full + summary + notes + faded + menu + headers. This is
 * the guarantee that the render NEVER exceeds the MCP-client harness's
 * inline tool-result token cap (CC `MAX_MCP_OUTPUT_TOKENS`, default 25 000
 * tokens) — past which the harness spills the whole payload to a flat,
 * user-readable `tool-results/*.txt` a subagent could Read. TIER 1 bounds
 * full bodies; this additionally bounds the SUMMARY/menu accumulation that
 * scales with the number of loaded topics (the residual TIER 1 left open).
 *
 * Enforced as a final, render-time compaction pass (`fitToInlineCeiling`
 * in `render.ts`): over budget → lowest-VALUE sections collapse to a
 * one-line count first (oldest/lowest-priority first; pins compact dead
 * last), each leaving a self-describing `recall_memory(id)` / `list_memory`
 * hint — smart compaction, never a file pointer or "use a subagent" path.
 *
 * Sized in BYTES (conservative — multibyte slugs/box-drawing inflate byte
 * count vs. token count, so the guard trips sooner). Default 32 KB: at the
 * worst observed density (~2.7 B/token) ≈ 12 K tokens, and even at a
 * pessimistic 1.5 B/token ≈ 21.8 K tokens — under the 25 K cap with
 * headroom for JSON-escaping + the response's sibling fields. Tunable via
 * `PANTHEON_RENDER_INLINE_CEILING`; non-positive / unparseable → Infinity
 * (disabled). MUST stay ≥ RENDER_FULLTEXT_BUDGET_BYTES to be coherent. */
export const RENDER_INLINE_CEILING_BYTES = resolveBudgetEnv(
  "PANTHEON_RENDER_INLINE_CEILING",
  32 * 1024,
);

/** Byte-aware cap for index-shape list results (`list_memory` /
 * `find_memory`): the serialized array of `MemoryIndexEntry` rows is the
 * whole payload, so the same inline-cap risk applies. The handler returns
 * newest-first rows until their estimated serialized size approaches this,
 * then a `truncated` flag + total count + a "narrow your query" hint.
 * Mirrors RENDER_INLINE_CEILING_BYTES with the same env override so the two
 * move together; falls back to it when unset. */
export const LIST_RESULT_CEILING_BYTES = resolveBudgetEnv(
  "PANTHEON_LIST_RESULT_CEILING",
  RENDER_INLINE_CEILING_BYTES === Number.POSITIVE_INFINITY
    ? 32 * 1024
    : RENDER_INLINE_CEILING_BYTES,
);

/** Hard upper bound on `find_memory` / `find_memory_any` `limit`, so an
 * agent-supplied `limit: 100000` can't force an oversized result. The
 * byte-aware cap still applies on top. */
export const FIND_LIMIT_MAX = 200;

function resolveBudgetEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
  return n;
}

export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
