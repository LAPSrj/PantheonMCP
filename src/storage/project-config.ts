import {
  ensureProjectMemoryDir,
  projectConfigFilePath,
  type Paths,
} from "./paths.ts";
import { readJson, writeJsonAtomic } from "./json.ts";

/** Per-project policy, stored at `projects/<project>/config.json`.
 *
 * Currently a single flag. `single_agent` locks the project to exactly
 * one persona: every brand-new persona-creation path (register / conjure
 * / summon / fork / merge / promote) is refused once the lone persona
 * exists, and the MCP server advertises a trimmed tool surface (no
 * persona-creation, no shared project-memory, no cross-persona `*_any`
 * reads) to sessions in such a project. The point is one persona shared
 * across many concurrent sessions, not a fleet. */
export interface ProjectConfig {
  single_agent?: boolean;
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
