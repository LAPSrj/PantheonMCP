import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Database } from "bun:sqlite";
import { openChatDb } from "../../storage/index.ts";
import {
  DEFAULT_STALE_THRESHOLD_MS,
  heartbeat,
  listActive,
  pruneStale,
  removeSubscriber,
  totalSubscribers,
  upsertSubscriber,
} from "../presence.ts";
import type { Subscriber } from "../types.ts";

let tmpDir: string;
let db: Database;

function sub(over: Partial<Subscriber> & { agent_id: string; username: string }): Subscriber {
  return {
    transient: false,
    project: "pantheon",
    status: "",
    mode: "all",
    connected_at: 1,
    last_seen: 1,
    last_event_at: 1,
    status_updated_at: 1,
    promoted_at: null,
    ...over,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-presence-"));
  db = openChatDb(path.join(tmpDir, "chat.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("upsertSubscriber writes a row that listActive sees inside the threshold", () => {
  upsertSubscriber(db, sub({ agent_id: "a-1", username: "vellumpike" }), 1000);
  const rows = listActive(db, { now: 1000 + DEFAULT_STALE_THRESHOLD_MS - 1 });
  expect(rows.map((r) => r.username)).toEqual(["vellumpike"]);
});

test("listActive hides rows older than the stale threshold", () => {
  upsertSubscriber(db, sub({ agent_id: "a-1", username: "vellumpike" }), 1000);
  const stale = listActive(db, { now: 1000 + DEFAULT_STALE_THRESHOLD_MS + 1 });
  expect(stale).toEqual([]);
});

test("heartbeat refreshes last_heartbeat without touching other fields", () => {
  upsertSubscriber(db, sub({ agent_id: "a-1", username: "vellumpike", status: "deep work" }), 1000);
  heartbeat(db, "a-1", 5000);
  const rows = listActive(db, { now: 5000 + 100 });
  expect(rows[0]?.last_heartbeat).toBe(5000);
  expect(rows[0]?.status).toBe("deep work");
});

test("heartbeat records last_activity_at when supplied; bare heartbeat leaves it", () => {
  upsertSubscriber(db, sub({ agent_id: "a-1", username: "vellumpike" }), 1000);
  // login upsert stamped last_activity_at = 1000.
  // A heartbeat carrying a fresh activity timestamp advances it.
  heartbeat(db, "a-1", 5000, 4800);
  let rows = listActive(db, { now: 5100 });
  expect(rows[0]?.last_heartbeat).toBe(5000);
  expect(rows[0]?.last_activity_at).toBe(4800);
  // A FROZEN agent: heartbeat keeps firing (process alive) but no fresh
  // activity → last_heartbeat advances, last_activity_at stays put.
  heartbeat(db, "a-1", 9000, 4800);
  rows = listActive(db, { now: 9100 });
  expect(rows[0]?.last_heartbeat).toBe(9000);
  expect(rows[0]?.last_activity_at).toBe(4800); // unchanged → zombie gap = 4200ms
});

test("removeSubscriber drops the row entirely", () => {
  upsertSubscriber(db, sub({ agent_id: "a-1", username: "vellumpike" }));
  removeSubscriber(db, "a-1");
  expect(totalSubscribers(db)).toBe(0);
});

test("pruneStale deletes rows older than the prune grace and reports count", () => {
  // now=2_000_000, grace=60_000 → cutoff at 1_940_000.
  // old's heartbeat (0) is below cutoff → pruned.
  // fresh's heartbeat (1_990_000) is above cutoff → kept.
  upsertSubscriber(db, sub({ agent_id: "old", username: "alpha" }), 0);
  upsertSubscriber(db, sub({ agent_id: "fresh", username: "beta" }), 1_990_000);
  const pruned = pruneStale(db, { now: 2_000_000, prune_grace_ms: 60_000 });
  expect(pruned).toBe(1);
  expect(totalSubscribers(db)).toBe(1);
});

test("listActive filters by project", () => {
  upsertSubscriber(db, sub({ agent_id: "a", username: "alpha", project: "X" }), 1000);
  upsertSubscriber(db, sub({ agent_id: "b", username: "beta", project: "Y" }), 1000);
  const rowsX = listActive(db, { now: 1100, project: "X" });
  expect(rowsX.map((r) => r.username)).toEqual(["alpha"]);
});
