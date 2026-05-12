/** Dream-pass types.
 *
 * A dream-pass calls a librarian (a sonnet-4-6 subagent run via
 * `claude -p`) over the calling persona's (or project's) active +
 * faded memory entries. The librarian proposes three kinds of
 * actions:
 *
 *   - fade(id)         — entry stays on disk but renders summary-only.
 *   - forget(id)       — entry is tombstoned (still on disk forever).
 *   - consolidate(...) — N existing entries collapse into one new
 *                        entry; the sources are forgotten.
 *
 * Pantheon applies the plan auto without a review step — the persona
 * has the same information the librarian had, so review wouldn't add
 * signal. An audit entry of `kind: "dream_log"` is appended summarizing
 * what changed.
 *
 * The librarian's output is validated against this schema before
 * apply. Malformed plans are rejected verbatim. */

export type DreamScope = "persona" | "project";

export interface DreamPlanFade {
  id: string;
  reason?: string;
}

export interface DreamPlanForget {
  id: string;
  reason?: string;
}

export interface DreamPlanConsolidate {
  /** Existing entry ids to roll up. Each gets forgotten on apply. */
  source_ids: string[];
  /** New entry created as the consolidation. */
  new_entry: {
    summary: string;
    text: string;
    kind?: string;
    core?: boolean;
  };
  reason?: string;
  /** For project-memory dreams, carry the original authors forward
   * so the consolidated entry can render `consolidated_from`. */
  consolidated_from?: Array<{ author?: string; summary: string }>;
}

export interface DreamPlan {
  fade: DreamPlanFade[];
  forget: DreamPlanForget[];
  consolidate: DreamPlanConsolidate[];
  /** Optional librarian-provided one-line summary of the pass's
   * overall posture. Surfaces in the dream_log audit entry's
   * summary when present. */
  posture_summary?: string;
}

export interface DreamApplyResult {
  scope: DreamScope;
  target: string; // username or project name
  faded: number;
  forgotten: number;
  consolidated: number;
  audit_entry_id: string;
  notes: string[];
}

export class DreamError extends Error {
  code: DreamErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: DreamErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "DreamError";
  }
}

export type DreamErrorCode =
  | "invalid_plan"
  | "librarian_failed"
  | "librarian_timeout"
  | "cap_exceeded"
  | "scope_invalid";
