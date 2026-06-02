import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  appendEntry,
  claimWatcher,
  getEntry,
  isWatcherOrphaned,
  loadStore,
  renderStore,
  sweepOrphanedWatchers,
  updateEntry,
} from "../index.ts";
import type { MemoryEntry } from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-watcher-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function arm(ownerAgentId: string): MemoryEntry {
  return appendEntry(paths, USER, {
    text: "Canada Post package 1Z999 — poll tracking every 6h, alert on delivery/exception.",
    summary: "when the CP watch is orphaned, re-arm the 6h tracking poll",
    kind: "watcher",
    topic: "liaison-watch",
    watcher: {
      owner_agent_id: ownerAgentId,
      owner_username: USER,
      scope: "persona",
      rearm: { crons: ["0 */6 * * * poll-cp 1Z999"], notes: "ledger at /tmp/cp.md" },
      close_condition: "package delivered",
      armed_at: 1000,
    },
  });
}

// --- storage round-trip ---

test("appendEntry persists the watcher meta on a kind:watcher entry", () => {
  const e = arm("agentA");
  const got = getEntry(paths, USER, e.id)!;
  expect(got.kind).toBe("watcher");
  expect(got.watcher?.owner_agent_id).toBe("agentA");
  expect(got.watcher?.owner_username).toBe(USER);
  expect(got.watcher?.scope).toBe("persona");
  expect(got.watcher?.rearm.crons).toEqual(["0 */6 * * * poll-cp 1Z999"]);
});

// --- isWatcherOrphaned predicate ---

test("predicate: orphaned only on positive evidence", () => {
  const e = arm("agentA");
  // owner live → not orphaned
  expect(isWatcherOrphaned(e, new Set(["agentA", "agentB"]))).toBe(false);
  // owner gone → orphaned
  expect(isWatcherOrphaned(e, new Set(["agentB"]))).toBe(true);
  // liveness unknown → never orphaned
  expect(isWatcherOrphaned(e, undefined)).toBe(false);
  // no binding → never orphaned
  const { watcher: _omit, ...noBinding } = e;
  expect(isWatcherOrphaned(noBinding, new Set())).toBe(false);
});

// --- render block ---

test("ORPHANED WATCHERS block: loud when owner gone, silent when live, skipped when liveness unknown", () => {
  arm("agentA");
  const store = loadStore(paths, USER);

  const orphaned = renderStore(store, { live_agent_ids: new Set(["agentB"]) }).text;
  expect(orphaned).toContain("ORPHANED WATCHERS");
  expect(orphaned).toContain("claim_watcher");
  expect(orphaned).toContain("poll-cp"); // re-arm payload surfaced

  const live = renderStore(store, { live_agent_ids: new Set(["agentA"]) }).text;
  expect(live).not.toContain("ORPHANED WATCHERS");

  const unknown = renderStore(store, {}).text;
  expect(unknown).not.toContain("ORPHANED WATCHERS");
});

test("render block ignores faded/closed watchers", () => {
  const e = arm("agentA");
  updateEntry(paths, USER, e.id, { status: "faded" });
  const store = loadStore(paths, USER);
  const out = renderStore(store, { live_agent_ids: new Set(["agentB"]) }).text;
  expect(out).not.toContain("ORPHANED WATCHERS");
});

// --- claim CAS ---

test("claimWatcher wins on an orphaned watcher and re-binds + returns rearm", () => {
  const e = arm("agentA"); // armed by A
  const res = claimWatcher(paths, USER, e.id, "agentB", new Set(["agentB"]), 2000);
  expect(res.won).toBe(true);
  expect(res.entry?.watcher?.owner_agent_id).toBe("agentB");
  expect(res.entry?.watcher?.last_rearmed_at).toBe(2000);
  expect(res.entry?.watcher?.rearm.crons).toBeDefined();
  // persisted
  expect(getEntry(paths, USER, e.id)!.watcher?.owner_agent_id).toBe("agentB");
});

test("claimWatcher loses when the owner is live (no thundering herd)", () => {
  const e = arm("agentA");
  // B claims first (A gone) → wins, owner now B (live).
  claimWatcher(paths, USER, e.id, "agentB", new Set(["agentB", "agentC"]), 2000);
  // C then tries with a live set that includes the new owner B → loses.
  const res = claimWatcher(paths, USER, e.id, "agentC", new Set(["agentB", "agentC"]), 2001);
  expect(res.won).toBe(false);
  expect(res.reason).toBe("not_orphaned");
  expect(res.owner_agent_id).toBe("agentB");
  expect(getEntry(paths, USER, e.id)!.watcher?.owner_agent_id).toBe("agentB");
});

test("claimWatcher errors cleanly on missing / non-watcher ids", () => {
  expect(claimWatcher(paths, USER, "nope/x", "agentB", new Set(), 1).reason).toBe("not_found");
  const note = appendEntry(paths, USER, { text: "a note", kind: "note", topic: "liaison-watch" });
  expect(claimWatcher(paths, USER, note.id, "agentB", new Set(), 1).reason).toBe("not_watcher");
});

// --- daemon-tick sweep ---

test("sweepOrphanedWatchers flags an orphan once, dedups, and resets on claim", () => {
  const e = arm("agentA");
  // First sweep with A gone → flagged + returned.
  const first = sweepOrphanedWatchers(paths, USER, new Set(["agentB"]), 3000);
  expect(first.map((w) => w.id)).toContain(e.id);
  expect(getEntry(paths, USER, e.id)!.watcher?.orphan_notified).toBe(true);
  // Second sweep → already notified → empty.
  const second = sweepOrphanedWatchers(paths, USER, new Set(["agentB"]), 3001);
  expect(second).toHaveLength(0);
  // Claim resets orphan_notified so a later death re-notifies.
  claimWatcher(paths, USER, e.id, "agentB", new Set(["agentB"]), 3002);
  expect(getEntry(paths, USER, e.id)!.watcher?.orphan_notified).toBe(false);
  const third = sweepOrphanedWatchers(paths, USER, new Set(["agentC"]), 3003);
  expect(third.map((w) => w.id)).toContain(e.id);
});

test("sweepOrphanedWatchers leaves a live-owner watcher untouched", () => {
  const e = arm("agentA");
  const swept = sweepOrphanedWatchers(paths, USER, new Set(["agentA"]), 3000);
  expect(swept).toHaveLength(0);
  expect(getEntry(paths, USER, e.id)!.watcher?.orphan_notified).toBeUndefined();
});
