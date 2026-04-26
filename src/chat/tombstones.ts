import type { Tombstone } from "./types.ts";

/** §10 — 30s default. Pure in-memory, never persists; daemon restart
 * clears every tombstone. */
export const DEFAULT_TOMBSTONE_MS = 30_000;

/** Per-router map: lowercased handle → Tombstone. Sweep stale via
 * daemon-tick; `prune` returns the count removed (for tests/metrics). */
export class TombstoneMap {
  private readonly entries = new Map<string, Tombstone>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: { ttl_ms?: number; clock?: () => number } = {}) {
    this.ttlMs = opts.ttl_ms ?? DEFAULT_TOMBSTONE_MS;
    this.clock = opts.clock ?? Date.now;
  }

  /** Record a tombstone for a vacated handle. */
  add(username: string, prior_agent_id: string): void {
    this.entries.set(username.toLowerCase(), {
      username,
      vacated_at: this.clock(),
      prior_agent_id,
    });
  }

  /** Look up an active (non-expired) tombstone by handle. Side-effect-
   * free — does not prune. */
  get(username: string): Tombstone | null {
    const entry = this.entries.get(username.toLowerCase());
    if (!entry) return null;
    if (this.isExpired(entry)) return null;
    return entry;
  }

  /** Remove a specific tombstone (e.g. after a successful reclaim). */
  delete(username: string): void {
    this.entries.delete(username.toLowerCase());
  }

  /** Sweep expired entries. Returns the count pruned. */
  prune(): number {
    let pruned = 0;
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /** Active (non-expired) tombstones — used by collision checks and
   * tests. */
  active(): Tombstone[] {
    return Array.from(this.entries.values()).filter((e) => !this.isExpired(e));
  }

  size(): number {
    return this.entries.size;
  }

  private isExpired(entry: Tombstone): boolean {
    return this.clock() - entry.vacated_at > this.ttlMs;
  }
}
