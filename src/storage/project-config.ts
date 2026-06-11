import {
  ensureProjectMemoryDir,
  projectConfigFilePath,
  type Paths,
} from "./paths.ts";
import { readJson, writeJsonAtomic } from "./json.ts";

/** Per-project policy, stored at `projects/<project>/config.json`.
 *
 * `single_agent` locks the project to exactly one persona: every
 * brand-new persona-creation path (register / conjure / summon / fork /
 * merge / promote) is refused once the lone persona exists, and the MCP
 * server advertises a trimmed tool surface (no persona-creation, no
 * shared project-memory, no cross-persona `*_any` reads) to sessions in
 * such a project. The point is one persona shared across many concurrent
 * sessions, not a fleet.
 *
 * `description` is a short (≤160 char) human-facing blurb surfaced by
 * `list_projects_any`. Optional. */
export interface ProjectConfig {
  single_agent?: boolean;
  description?: string;
}

/** Max length of a project `description`. Enforced on write by
 * `setProjectDescription` (and the `edit_project` tool handler). */
export const MAX_PROJECT_DESCRIPTION = 160;

/** Validate a project name for use as a filesystem directory component.
 * Returns the name unchanged on success; throws `Error` otherwise. The
 * project name is used verbatim as a path segment under `projects/`, so
 * it must not be empty, contain a separator, or be a traversal token. */
export function assertValidProjectName(project: string): string {
  if (
    project.length === 0 ||
    project === "." ||
    project === ".." ||
    project.includes("/") ||
    project.includes("\\") ||
    project.includes("\0")
  ) {
    throw new Error(
      `Invalid project name '${project}': must be a non-empty single path segment (no '/', '\\', '..').`,
    );
  }
  return project;
}

/** Read a project's config. Returns an empty object when no config file
 * exists (the common case — most projects have no policy). Never throws
 * on a missing file. */
export function readProjectConfig(paths: Paths, project: string): ProjectConfig {
  const cfg = readJson<ProjectConfig>(projectConfigFilePath(paths, project));
  return cfg ?? {};
}

/** Write a project's config via atomic-rename. Ensures the project
 * directory exists first (mirrors project-memory writes). */
export function writeProjectConfig(
  paths: Paths,
  project: string,
  config: ProjectConfig,
): void {
  ensureProjectMemoryDir(paths, project);
  writeJsonAtomic(projectConfigFilePath(paths, project), config);
}

/** True when the project is locked to a single persona. The default
 * (no config file, or the flag unset) is `false` — single-agent is
 * strictly opt-in. */
export function isProjectSingleAgent(paths: Paths, project: string): boolean {
  return readProjectConfig(paths, project).single_agent === true;
}

/** Toggle a project's single-agent flag, preserving any other config
 * fields. Returns the resulting config. */
export function setProjectSingleAgent(
  paths: Paths,
  project: string,
  on: boolean,
): ProjectConfig {
  const next: ProjectConfig = { ...readProjectConfig(paths, project), single_agent: on };
  writeProjectConfig(paths, project, next);
  return next;
}

/** Set (or clear) a project's `description`, preserving other config
 * fields. Pass `null` to clear it. Throws when the text exceeds
 * `MAX_PROJECT_DESCRIPTION`. Returns the resulting config. */
export function setProjectDescription(
  paths: Paths,
  project: string,
  description: string | null,
): ProjectConfig {
  const trimmed = description === null ? null : description.trim();
  if (trimmed !== null && trimmed.length > MAX_PROJECT_DESCRIPTION) {
    throw new Error(
      `Project description too long (${trimmed.length} > ${MAX_PROJECT_DESCRIPTION} chars).`,
    );
  }
  const current = readProjectConfig(paths, project);
  const next: ProjectConfig = { ...current };
  if (trimmed === null || trimmed.length === 0) delete next.description;
  else next.description = trimmed;
  writeProjectConfig(paths, project, next);
  return next;
}
