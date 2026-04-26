import fs from "node:fs";
import path from "node:path";
import {
  ensurePersonaDir,
  personaDir,
  readJson,
  writeJsonAtomic,
  type Paths,
} from "../storage/index.ts";
import { loadStore, mutateStore } from "./store.ts";
import { MemoryError, type MemoryStore } from "./types.ts";

/** §6 LOW memory snapshots — parallel JSON next to the main store
 * at `personas/<handle>/memory.snapshots/<label>.json`.
 *
 * No auto-cleanup: snapshots count toward disk and persist until
 * an explicit operator action (or `pantheon validate` flagging
 * stale labels) removes them. */

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function snapshotsDir(paths: Paths, username: string): string {
  return path.join(personaDir(paths, username), "memory.snapshots");
}

function snapshotFilePath(paths: Paths, username: string, label: string): string {
  return path.join(snapshotsDir(paths, username), `${label}.json`);
}

export interface SnapshotMeta {
  label: string;
  size_bytes: number;
  created_at: string;
}

export function validateLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new MemoryError(
      "invalid_status",
      `Snapshot label '${label}' must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.`,
    );
  }
}

/** Persist a labeled snapshot of the persona's current memory store.
 * Atomic-rename via the storage layer's `writeJsonAtomic`. Returns
 * the snapshot's metadata. */
export function snapshotMemory(
  paths: Paths,
  username: string,
  label: string,
): SnapshotMeta {
  validateLabel(label);
  ensurePersonaDir(paths, username);
  fs.mkdirSync(snapshotsDir(paths, username), { recursive: true });
  const store = loadStore(paths, username);
  const target = snapshotFilePath(paths, username, label);
  writeJsonAtomic(target, store);
  const stat = fs.statSync(target);
  return {
    label,
    size_bytes: stat.size,
    created_at: new Date(stat.mtimeMs).toISOString(),
  };
}

/** Replace the main memory store with the snapshot's contents. The
 * previous main is overwritten — reversible only by another
 * snapshot. */
export function restoreMemory(
  paths: Paths,
  username: string,
  label: string,
): { restored_label: string; entry_count: number } {
  validateLabel(label);
  const target = snapshotFilePath(paths, username, label);
  const snapshot = readJson<MemoryStore>(target);
  if (!snapshot) {
    throw new MemoryError(
      "entry_not_found",
      `No snapshot named '${label}' for persona '${username}'.`,
    );
  }
  mutateStore(paths, username, () => snapshot);
  return { restored_label: label, entry_count: snapshot.entries.length };
}

/** List every snapshot for a persona, sorted by `created_at` desc
 * (newest first). */
export function listSnapshots(paths: Paths, username: string): SnapshotMeta[] {
  const dir = snapshotsDir(paths, username);
  if (!fs.existsSync(dir)) return [];
  const out: SnapshotMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const label = name.slice(0, -5);
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      out.push({
        label,
        size_bytes: stat.size,
        created_at: new Date(stat.mtimeMs).toISOString(),
      });
    } catch {
      // Best-effort skip — operator can fix via `pantheon validate`.
    }
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out;
}

/** Delete a labeled snapshot. Returns true when the file existed. */
export function deleteSnapshot(
  paths: Paths,
  username: string,
  label: string,
): boolean {
  validateLabel(label);
  const target = snapshotFilePath(paths, username, label);
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
