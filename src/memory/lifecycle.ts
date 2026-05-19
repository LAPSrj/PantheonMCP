/** Lifecycle-rule coercion for memory writes (§4).
 *
 * The lifecycle rule constrains how aggressively an entry can be
 * demoted in a single pass:
 *
 *   - Core entries fade-only. A `forget` on a `core: true` entry is
 *     coerced to `fade` so the entry survives at least one full
 *     dream cycle before it can be lost.
 *
 *   - Active entries with a reference-shape `kind` (gotcha, fact,
 *     decision, design, cross-mcp-workflow, sibling-network,
 *     posture-rail) get the same multi-pass protection: a `forget`
 *     on such an entry is coerced to `fade`. The next pass (where
 *     the entry is faded, not active) can forget normally.
 *
 *   - Faded reference entries, non-reference entries, and
 *     `_unspecified`-kind entries follow the normal forget path.
 *
 * The rule lives at the MCP layer (this module + handlers/memory.ts)
 * rather than the planning layer so the data-store invariants hold
 * regardless of caller — librarian, persona itself, or any other
 * agent calling `forget_memory`. */

import { MemoryError, type MemoryEntry } from "./types.ts";
import { fadeEntry, forgetEntry, getEntry } from "./operations.ts";
import type { Paths } from "../storage/index.ts";

/** Kinds whose forget bar is high enough that a single pass should
 * never demote them straight from active → forgotten. Matches the
 * librarian's typology in `librarian-skill.md`. `handoff` is
 * intentionally excluded: handoffs cycle by design (TTL-fade after
 * 7 days; clearly ephemeral). */
export const REFERENCE_KINDS: ReadonlySet<string> = new Set([
  "gotcha",
  "fact",
  "decision",
  "design",
  "cross-mcp-workflow",
  "sibling-network",
  "posture-rail",
]);

export interface ForgetCoercionResult {
  /** The post-mutation entry. Status is `"faded"` when coerced,
   * `"forgotten"` otherwise. */
  entry: MemoryEntry;
  /** `"fade"` when the lifecycle rule coerced the action; `null`
   * when the forget happened normally. */
  coerced: "fade" | null;
  /** When coerced, a human-readable reason. Omitted on normal
   * forgets. */
  reason?: string;
}

/** Apply `forget` semantics with lifecycle-rule coercion. Callers
 * (the MCP `forget_memory` handler, librarian flows, future bulk
 * cleanup tools) should always go through this helper rather than
 * calling `forgetEntry` directly so the rule is enforced
 * regardless of code path. */
export function forgetEntryWithLifecycleCoercion(
  paths: Paths,
  username: string,
  id: string,
): ForgetCoercionResult {
  const existing = getEntry(paths, username, id);
  if (!existing) {
    throw new MemoryError(
      "entry_not_found",
      `No memory entry '${id}' for '${username}'.`,
    );
  }

  if (existing.core === true) {
    const faded = fadeEntry(paths, username, id);
    return {
      entry: faded,
      coerced: "fade",
      reason:
        `core entry — lifecycle rule fades core, never forgets directly. ` +
        `Demote at most one tier per pass; the next pass can forget the (now-faded) entry.`,
    };
  }

  if (
    existing.status === "active" &&
    typeof existing.kind === "string" &&
    REFERENCE_KINDS.has(existing.kind)
  ) {
    const faded = fadeEntry(paths, username, id);
    return {
      entry: faded,
      coerced: "fade",
      reason:
        `active reference-kind entry (kind=${existing.kind}) — lifecycle rule ` +
        `fades active reference-shape entries; never forgets directly. The ` +
        `next pass (where the entry is faded) can forget normally.`,
    };
  }

  const forgotten = forgetEntry(paths, username, id);
  return { entry: forgotten, coerced: null };
}
