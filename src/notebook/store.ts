import {
  ensurePersonaDir,
  mutateJsonAtomic,
  notebookFilePath,
  readJson,
  type Paths,
} from "../storage/index.ts";
import type { NotebookStore } from "./types.ts";

function emptyStore(): NotebookStore {
  return { version: 1, topics: [] };
}

export function loadNotebookStore(paths: Paths, username: string): NotebookStore {
  const data = readJson<NotebookStore>(notebookFilePath(paths, username));
  return data ?? emptyStore();
}

/** Mutate the persona's notebook store atomically. Uses the same
 * fingerprint-guarded mutate-then-rename as memory so concurrent
 * sibling incarnations don't clobber each other. */
export function mutateNotebookStore(
  paths: Paths,
  username: string,
  mutator: (current: NotebookStore) => NotebookStore | undefined,
): NotebookStore {
  ensurePersonaDir(paths, username);
  const result = mutateJsonAtomic<NotebookStore>(
    notebookFilePath(paths, username),
    (current) => mutator(current ?? emptyStore()),
  );
  return result ?? emptyStore();
}
