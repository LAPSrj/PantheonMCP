/** Project-notebook types.
 *
 * Mirror of `src/notebook/types.ts` keyed on `project` rather than
 * persona handle. Pages always carry `author_username` (canonical
 * persona, not auto-suffixed handle) for blame/attribution; the read
 * surface surfaces it on every page so peers know who wrote what.
 *
 * Same status model (`"active" | "deleted"`), same auto-vanish-when-
 * empty TOC behavior. Bodies are never inlined at login — the resume
 * summary's `project_notebooks` field carries TOC entries only.
 */

export type ProjectNotebookPageStatus = "active" | "deleted";

export interface ProjectNotebookPage {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  status: ProjectNotebookPageStatus;
  created_at: string;
  updated_at: string;
  /** Canonical persona username of the author. Stamped on append/update
   * for cross-persona attribution. */
  author_username?: string;
}

export interface ProjectNotebookTopic {
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
  pages: ProjectNotebookPage[];
}

export interface ProjectNotebookStore {
  version: 1;
  topics: ProjectNotebookTopic[];
}

export interface ProjectNotebookTopicRef {
  slug: string;
  title: string;
  page_count: number;
  last_touched_at: string;
}

export class ProjectNotebookError extends Error {
  code: ProjectNotebookErrorCode;
  extra: Record<string, unknown>;
  constructor(
    code: ProjectNotebookErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "ProjectNotebookError";
  }
}

export type ProjectNotebookErrorCode =
  | "topic_not_found"
  | "topic_exists"
  | "page_not_found"
  | "invalid_topic_slug"
  | "invalid_title"
  | "missing_body"
  | "invalid_status"
  | "invalid_project"
  | "file_exists"
  | "invalid_path";
