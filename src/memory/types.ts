/** Memory subsystem types. Mirrors §4 of the brainstorm doc. */

export type MemoryStatus = "active" | "faded" | "forgotten";

/** Three-tier entry body per §4 / §11b:
 *
 *   - `summary`   — ≤240 char one-line headline. Always rendered (Core, Active, Index).
 *   - `text`      — load-bearing body. Rendered in Core/Active when within budget.
 *                   Counted against the byte budget.
 *   - `details`   — optional ≤5MB verbatim payload (quotes, chat dialogs,
 *                   post-mortem prose). NEVER inlined at startup; only via
 *                   `get_memory_details(id)`. Does NOT count against budget.
 *
 * `core: true` is pantheon's replacement for summon-mcp's `pinned: true`.
 * Code reads `core` only — no `pinned` fallback (§9 / §11b decision).
 */
export interface MemoryEntry {
  id: string;
  date: string;
  summary: string;
  text: string;
  status: MemoryStatus;
  details?: string;
  kind?: string;
  /** Username of the summoner whose session created this entry, when
   * the entry was appended during a summon-spawned session. Optional. */
  summoner_username?: string;
  /** When true, the entry is treated as Core: rendered in full at
   * startup subject to the 10KB middle-out cap. */
  core?: boolean;
  /** ms-epoch expiry timestamp. The §6 MEDIUM idle-handoff slot
   * sets this to `now + 7 days` for `kind: "handoff"` entries; the
   * daemon-tick auto-fades past expiry. Schema-additive — existing
   * entries without `expires_at` never auto-fade. */
  expires_at?: number;
  /** §6 MEDIUM memory annotations / threading. Entry id this entry
   * is replying to. Renderer indents children under their parent in
   * the Index synopsis. Validated at write time — referenced ids
   * must exist in the same persona's memory. */
  replies_to?: string;
  /** §6 MEDIUM. Entry ids cited inline at the end of the synopsis
   * (`[id1] [id2]`). Validated at write time. */
  see_also?: string[];
}

export interface MemoryStore {
  version: 1;
  entries: MemoryEntry[];
}

/** Index-shape returned by `list_memory`. Cheap; no body content. */
export interface MemoryIndexEntry {
  id: string;
  date: string;
  status: MemoryStatus;
  core: boolean;
  summary: string;
  size_kb: number;
  has_details: boolean;
  kind?: string;
}

export class MemoryError extends Error {
  code: MemoryErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: MemoryErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "MemoryError";
  }
}

export type MemoryErrorCode =
  | "entry_not_found"
  | "entry_too_large"
  | "summary_too_long"
  | "missing_text"
  | "invalid_status"
  | "invalid_reference";
