import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Database } from "bun:sqlite";
import { openChatDb } from "../../storage/sqlite.ts";
import {
  consumePendingRestRequests,
  pendingRestRequests,
  pruneStaleRestRequests,
  writeRestRequest,
} from "../rest-requests.ts";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-rest-req-"));
  db = openChatDb(path.join(tmpDir, "chat.db"));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("writeRestRequest persists a pending row", () => {
  const id = writeRestRequest(db, {
    target_agent_id: "agent-A",
    from_agent_id: "agent-B",
    kind: "rest",
    reason: "supervisor wrap-up",
    now: 1_000_000,
  });
  expect(id.length).toBeGreaterThan(0);
  const pending = pendingRestRequests(db, "agent-A");
  expect(pending.length).toBe(1);
  expect(pending[0]!.target_agent_id).toBe("agent-A");
  expect(pending[0]!.from_agent_id).toBe("agent-B");
  expect(pending[0]!.kind).toBe("rest");
  expect(pending[0]!.reason).toBe("supervisor wrap-up");
});

test("consumePendingRestRequests claims and DELETEs rows atomically", () => {
  writeRestRequest(db, {
    target_agent_id: "agent-A",
    from_agent_id: "agent-B",
    kind: "rest",
    now: 1_000_000,
  });
  writeRestRequest(db, {
    target_agent_id: "agent-A",
    from_agent_id: "agent-C",
    kind: "exit",
    now: 1_000_500,
  });

  const claimed = consumePendingRestRequests(db, "agent-A");
  expect(claimed.length).toBe(2);
  // Ordered oldest-first.
  expect(claimed[0]!.kind).toBe("rest");
  expect(claimed[1]!.kind).toBe("exit");

  // Rows are gone from the table — no audit trail.
  const remaining = db
    .query(`SELECT COUNT(*) AS c FROM rest_requests WHERE target_agent_id = ?`)
    .get("agent-A") as { c: number };
  expect(remaining.c).toBe(0);

  // A second consume claims nothing.
  expect(consumePendingRestRequests(db, "agent-A").length).toBe(0);
});

test("consumePendingRestRequests is scoped to the requested agent_id", () => {
  writeRestRequest(db, {
    target_agent_id: "agent-A",
    from_agent_id: "agent-B",
    kind: "rest",
    now: 1_000_000,
  });
  writeRestRequest(db, {
    target_agent_id: "agent-X",
    from_agent_id: "agent-B",
    kind: "exit",
    now: 1_000_000,
  });
  const claimed = consumePendingRestRequests(db, "agent-A");
  expect(claimed.length).toBe(1);
  expect(claimed[0]!.target_agent_id).toBe("agent-A");
  // agent-X's row is untouched.
  expect(pendingRestRequests(db, "agent-X").length).toBe(1);
});

test("pruneStaleRestRequests deletes rows older than the ttl", () => {
  writeRestRequest(db, {
    target_agent_id: "agent-A",
    from_agent_id: null,
    kind: "rest",
    now: 1_000_000,
  });
  writeRestRequest(db, {
    target_agent_id: "agent-A",
    from_agent_id: null,
    kind: "rest",
    now: 5_000_000,
  });
  // ttl = 1s, now = 6_000_000 → cutoff = 5_999_000
  // Row at 1_000_000 is stale (older than cutoff).
  // Row at 5_000_000 is also stale (older than cutoff).
  const dropped = pruneStaleRestRequests(db, 1_000, 6_000_000);
  expect(dropped).toBe(2);
  expect(pendingRestRequests(db, "agent-A").length).toBe(0);
});

test("pruneStaleRestRequests leaves fresh rows alone", () => {
  writeRestRequest(db, {
    target_agent_id: "agent-A",
    from_agent_id: null,
    kind: "rest",
    now: 1_000_000,
  });
  // ttl = 1 hour, now = 1_001_000 → cutoff = -2_599_000
  // The row at 1_000_000 is well inside the window.
  const dropped = pruneStaleRestRequests(db, 60 * 60 * 1000, 1_001_000);
  expect(dropped).toBe(0);
  expect(pendingRestRequests(db, "agent-A").length).toBe(1);
});
