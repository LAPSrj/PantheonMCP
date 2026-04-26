import fs from "node:fs";
import path from "node:path";

const MUTATE_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5;

export class StorageError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "StorageError";
  }
}

function tmpName(target: string): string {
  // Per-write unique suffix: pid + monotonic-ish timestamp + random.
  // Multiple writers in the same millisecond won't collide.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${target}.tmp.${process.pid}.${Date.now()}.${rand}`;
}

function sleepSync(ms: number): void {
  // Synchronous sleep via Atomics.wait on a SharedArrayBuffer view.
  // Storage helpers run on the daemon's main loop; we want true blocking,
  // not setTimeout-style yields, so a fast read-after-rename is durable.
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/** Write `payload` JSON-encoded to `target` via tmp + rename. POSIX-atomic. */
export function writeJsonAtomic(target: string, payload: unknown): void {
  const tmp = tmpName(target);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp may already be gone (renamed) or never created
    }
    throw err;
  }
}

/**
 * Read JSON from `path`. Returns `null` if the file doesn't exist.
 * On parse failure (which can happen mid-rename when a concurrent writer
 * has truncated the file but not yet renamed), retry once after 5ms.
 */
export function readJson<T>(target: string): T | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      if (attempt === 0) {
        sleepSync(RETRY_BACKOFF_MS);
        continue;
      }
      throw new StorageError(
        "json_parse_failed",
        `Failed to parse JSON at ${target}: ${(err as Error).message}`,
      );
    }
  }
  // Unreachable: the loop either returns or throws.
  /* c8 ignore next */
  throw new StorageError("json_parse_failed", `Unreachable read loop for ${target}`);
}

/**
 * Mtime-guarded mutate-then-rename. Up to 3 attempts with 5ms backoff if a
 * concurrent writer raced us between read and rename.
 *
 * `mutator` is called with the current parsed value (or `null` if the file
 * doesn't exist) and must return the next value to persist. If it returns
 * `undefined`, the file is left untouched and `mutateJsonAtomic` returns
 * the loaded value.
 */
export function mutateJsonAtomic<T>(
  target: string,
  mutator: (current: T | null) => T | undefined,
): T | null {
  for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
    const beforeFp = statFingerprintOrNull(target);
    const current = readJson<T>(target);
    const next = mutator(current);
    if (next === undefined) return current;

    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = tmpName(target);
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(next, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      const afterFp = statFingerprintOrNull(target);
      if (fingerprintChanged(beforeFp, afterFp)) {
        // Sibling raced us between our read and our pending rename. Retry.
        fs.unlinkSync(tmp);
        if (attempt < MUTATE_MAX_ATTEMPTS - 1) {
          sleepSync(RETRY_BACKOFF_MS);
          continue;
        }
        throw new StorageError(
          "mutate_conflict",
          `Concurrent writer kept winning ${target} after ${MUTATE_MAX_ATTEMPTS} attempts.`,
        );
      }

      fs.renameSync(tmp, target);
      return next;
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // already cleaned up
      }
      if (err instanceof StorageError && err.code === "mutate_conflict") {
        throw err;
      }
      // Filesystem error (disk full, permission, etc.) — surface immediately.
      throw err;
    }
  }
  /* c8 ignore next */
  throw new StorageError("mutate_conflict", `Exhausted retries for ${target}`);
}

/** A file fingerprint robust against same-millisecond races. We combine
 * nanosecond-precision mtime (where supported), inode, and size — any
 * one of these moving signals a sibling write between read and rename. */
interface FileFingerprint {
  mtimeNs: bigint;
  ino: bigint;
  size: bigint;
}

function statFingerprintOrNull(target: string): FileFingerprint | null {
  try {
    const s = fs.statSync(target, { bigint: true });
    return { mtimeNs: s.mtimeNs, ino: s.ino, size: s.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function fingerprintChanged(
  before: FileFingerprint | null,
  after: FileFingerprint | null,
): boolean {
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  return (
    before.mtimeNs !== after.mtimeNs ||
    before.ino !== after.ino ||
    before.size !== after.size
  );
}
