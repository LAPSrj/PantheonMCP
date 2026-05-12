/** Notebook subsystem types.
 *
 * Notebook is a per-persona, on-demand reference store. Distinct from
 * memory (which renders into the prompt at login): notebook bodies are
 * NEVER inlined at startup — only a TOC of topics surfaces in
 * `resume_summary`. Bodies are fetched on demand via the notebook
 * tools.
 *
 * Shape:
 *   - A `NotebookStore` holds a list of `NotebookTopic` records, keyed
 *     by `slug` (caller-supplied, kebab, no auto-suffix).
 *   - Each topic owns an ordered list of `NotebookPage` records, keyed
 *     by `id` (slugified from title within the topic; `-2`/`-3` dedup).
 *   - Pages have a `status` of `"active"` or `"deleted"`. Deleted
 *     pages are filtered from default reads but kept on disk for
 *     restore via `notebook_restore_page`. There is no hard-delete
 *     surface in v1.
 *   - When every page in a topic is deleted, the topic auto-vanishes
 *     from the TOC. The empty topic record is retained on disk
 *     (cheap; preserves slug history) and reappears when a page is
 *     restored or appended. Hard purge of empty topics is a future
 *     compaction concern, out of v1.
 *
 * Sibling: `src/project-notebook/types.ts` mirrors this shape for the
 * project-shared variant, with an `author_username` field stamped on
 * pages for git-blame-style attribution.
 */

export type NotebookPageStatus = "active" | "deleted";

export interface NotebookPage {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  status: NotebookPageStatus;
  created_at: string;
  updated_at: string;
  /** Canonical persona username of the author. For per-persona
   * notebooks this matches the owning persona; stamped anyway so a
   * future move/merge across personas doesn't lose attribution. */
  author_username?: string;
}

export interface NotebookTopic {
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
  pages: NotebookPage[];
}

export interface NotebookStore {
  version: 1;
  topics: NotebookTopic[];
}

/** TOC-shape returned by `list_topics` and embedded in `resume_summary`.
 * Active pages only — deleted pages do not count toward `page_count`. */
export interface NotebookTopicRef {
  slug: string;
  title: string;
  page_count: number;
  last_touched_at: string;
}

/** Soft thresholds surfaced as `warning` on writes — non-blocking. */
export const PAGE_BODY_WARN_BYTES = 64 * 1024;
export const TOPIC_TOTAL_WARN_BYTES = 1024 * 1024;

/** Hard caps on TOC fields. */
export const TITLE_MAX_CHARS = 240;
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class NotebookError extends Error {
  code: NotebookErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: NotebookErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "NotebookError";
  }
}

export type NotebookErrorCode =
  | "topic_not_found"
  | "topic_exists"
  | "page_not_found"
  | "invalid_topic_slug"
  | "invalid_title"
  | "missing_body"
  | "invalid_status"
  | "file_exists"
  | "invalid_path";
