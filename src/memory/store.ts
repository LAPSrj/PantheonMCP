import {
  ensurePersonaDir,
  memoryFilePath,
  mutateJsonAtomic,
  readJson,
  type Paths,
} from "../storage/index.ts";
import type { MemoryStore } from "./types.ts";

function emptyStore(): MemoryStore {
  return { version: 1, entries: [] };
}

export function loadStore(paths: Paths, username: string): MemoryStore {
  const data = readJson<MemoryStore>(memoryFilePath(paths, username));
  return data ?? emptyStore();
}

/** Mutate a memory store atomically. Uses the fingerprint-guarded
 * mutate-then-rename so concurrent incarnations writing to the same
 * shared memory file don't lose entries. The mutator may return a
 * new store to persist or `undefined` to leave the file untouched. */
export function mutateStore(
  paths: Paths,
  username: string,
  mutator: (current: MemoryStore) => MemoryStore | undefined,
): MemoryStore {
  ensurePersonaDir(paths, username);
  const result = mutateJsonAtomic<MemoryStore>(
    memoryFilePath(paths, username),
    (current) => mutator(current ?? emptyStore()),
  );
  return result ?? emptyStore();
}
