/** Project-memory types.
 *
 * Project memory is shared across every agent in a project — facts,
 * decisions, gotchas that outlive individual personas. Same
 * three-tier body shape as persona memory (summary / text / details),
 * same Active/Core/Faded/Forgotten status model, with an added
 * `author_username` field for git-blame-style transparency.
 *
 * Forgotten entries are kept FOREVER — they're filtered out of
 * default lists/render but never hard-purged, so anything can be
 * restored via `restore_project_memory(id)`. */

export type ProjectMemoryStatus = "active" | "faded" | "forgotten";

export interface ProjectMemoryEntry {
  id: string;
  date: string;
  summary: string;
  text: string;
  status: ProjectMemoryStatus;
  details?: string;
  kind?: string;
  /** Persona username (canonical, not the auto-suffixed handle) of
   * the agent who appended this entry. Surfaces in renders so peers
   * can attribute facts. Optional only because legacy / migrated
   * entries may not have an author. */
  author_username?: string;
  /** When true, the entry renders in the Core tier — full text up to
   * the project-core budget. */
  core?: boolean;
  /** ms-epoch expiry timestamp. Same shape as persona memory. */
  expires_at?: number;
  /** When non-empty, this entry's `text` was synthesized by a dream
   * pass from the listed source entries. Surfaces in the rendered
   * header so peers can trace the merge. */
  consolidated_from?: Array<{ author?: string; summary: string }>;
}

export interface ProjectMemoryStore {
  version: 1;
  entries: ProjectMemoryEntry[];
}

export interface ProjectMemoryIndexEntry {
  id: string;
  date: string;
  status: ProjectMemoryStatus;
  core: boolean;
  summary: string;
  size_kb: number;
  has_details: boolean;
  kind?: string;
  author_username?: string;
}

export class ProjectMemoryError extends Error {
  code: ProjectMemoryErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: ProjectMemoryErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "ProjectMemoryError";
  }
}

export type ProjectMemoryErrorCode =
  | "entry_not_found"
  | "entry_too_large"
  | "summary_too_long"
  | "missing_text"
  | "invalid_status"
  | "invalid_project";
