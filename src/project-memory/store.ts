import {
  ensureProjectMemoryDir,
  mutateJsonAtomic,
  projectMemoryFilePath,
  readJson,
  type Paths,
} from "../storage/index.ts";
import type { ProjectMemoryStore } from "./types.ts";

const PROJECT_NAME_OK = /^[A-Za-z0-9_.\-]+$/;

export function validateProjectName(project: string): void {
  if (!PROJECT_NAME_OK.test(project)) {
    throw new Error(
      `Project name '${project}' contains disallowed characters. Allowed: A-Z, a-z, 0-9, '_', '.', '-'.`,
    );
  }
}

function emptyStore(): ProjectMemoryStore {
  return { version: 1, entries: [] };
}

export function loadProjectStore(
  paths: Paths,
  project: string,
): ProjectMemoryStore {
  validateProjectName(project);
  const data = readJson<ProjectMemoryStore>(
    projectMemoryFilePath(paths, project),
  );
  return data ?? emptyStore();
}

/** Mutate a project-memory store atomically. Same fingerprint-guarded
 * mutate-then-rename as persona memory — concurrent agents writing to
 * the same project memory won't lose entries. */
export function mutateProjectStore(
  paths: Paths,
  project: string,
  mutator: (current: ProjectMemoryStore) => ProjectMemoryStore | undefined,
): ProjectMemoryStore {
  validateProjectName(project);
  ensureProjectMemoryDir(paths, project);
  const result = mutateJsonAtomic<ProjectMemoryStore>(
    projectMemoryFilePath(paths, project),
    (current) => mutator(current ?? emptyStore()),
  );
  return result ?? emptyStore();
}
