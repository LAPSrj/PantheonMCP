import {
  ensureProjectNotebookDir,
  mutateJsonAtomic,
  projectNotebookFilePath,
  readJson,
  type Paths,
} from "../storage/index.ts";
import { ProjectNotebookError, type ProjectNotebookStore } from "./types.ts";

const PROJECT_NAME_OK = /^[A-Za-z0-9_.\-]+$/;

export function validateProjectName(project: string): void {
  if (!PROJECT_NAME_OK.test(project)) {
    throw new ProjectNotebookError(
      "invalid_project",
      `Project name '${project}' contains disallowed characters. Allowed: A-Z, a-z, 0-9, '_', '.', '-'.`,
    );
  }
}

function emptyStore(): ProjectNotebookStore {
  return { version: 1, topics: [] };
}

export function loadProjectNotebookStore(
  paths: Paths,
  project: string,
): ProjectNotebookStore {
  validateProjectName(project);
  const data = readJson<ProjectNotebookStore>(
    projectNotebookFilePath(paths, project),
  );
  return data ?? emptyStore();
}

export function mutateProjectNotebookStore(
  paths: Paths,
  project: string,
  mutator: (current: ProjectNotebookStore) => ProjectNotebookStore | undefined,
): ProjectNotebookStore {
  validateProjectName(project);
  ensureProjectNotebookDir(paths, project);
  const result = mutateJsonAtomic<ProjectNotebookStore>(
    projectNotebookFilePath(paths, project),
    (current) => mutator(current ?? emptyStore()),
  );
  return result ?? emptyStore();
}
