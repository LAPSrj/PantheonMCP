import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Database } from "bun:sqlite";
import { openChatDb } from "../../storage/sqlite.ts";
import {
  writeSummon,
  confirmSummon,
  pendingSummonsForSummoner,
  bumpSummonRetry,
  markSummonFailed,
  getSummon,
  pruneStaleSummons,
  DEFAULT_SUMMON_TTL_MS,
} from "../summons.ts";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-summons-"));
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

test("writeSummon persists a pending row with the given nonce", () => {
  const id = writeSummon(db, {
    id: "nonce-1",
    summoner_agent_id: "agent-S",
    target_username: "moth-whistle",
    target_project: "pantheon",
    spawn_args_json: JSON.stringify({ username: "moth-whistle", prompt: "go" }),
    now: 1_000_000,
  });
  expect(id).toBe("nonce-1");

  const row = getSummon(db, "nonce-1");
  expect(row).not.toBeNull();
  expect(row!.state).toBe("pending");
  expect(row!.summoner_agent_id).toBe("agent-S");
  expect(row!.target_username).toBe("moth-whistle");
  expect(row!.retries).toBe(0);
  expect(row!.confirmed_at).toBeNull();
  expect(row!.spawned_at).toBe(1_000_000);
});

test("writeSummon mints a nonce when none supplied", () => {
  const id = writeSummon(db, {
    summoner_agent_id: "agent-S",
    target_username: "moth-whistle",
    target_project: "pantheon",
  });
  expect(id.length).toBeGreaterThan(0);
  expect(getSummon(db, id)).not.toBeNull();
});

test("confirmSummon flips state and records the confirming agent", () => {
  writeSummon(db, {
    id: "nonce-1",
    summoner_agent_id: "agent-S",
    target_username: "moth-whistle",
    target_project: "pantheon",
    now: 1_000,
  });
  const changed = confirmSummon(db, "nonce-1", "agent-CHILD", 2_000);
  expect(changed).toBe(1);

  const row = getSummon(db, "nonce-1")!;
  expect(row.state).toBe("confirmed");
  expect(row.confirmed_at).toBe(2_000);
  expect(row.confirmed_agent_id).toBe("agent-CHILD");
});

test("confirmSummon is idempotent — a second confirm is a no-op", () => {
  writeSummon(db, {
    id: "nonce-1",
    summoner_agent_id: "agent-S",
    target_username: "moth-whistle",
    target_project: "pantheon",
  });
  expect(confirmSummon(db, "nonce-1", "agent-CHILD", 2_000)).toBe(1);
  // Re-login by the same child must not churn the row.
  expect(confirmSummon(db, "nonce-1", "agent-CHILD", 9_999)).toBe(0);
  expect(getSummon(db, "nonce-1")!.confirmed_at).toBe(2_000);
});

test("confirmSummon on an unknown nonce updates nothing", () => {
  expect(confirmSummon(db, "no-such-nonce", "agent-X")).toBe(0);
});

test("pendingSummonsForSummoner returns only this summoner's pending rows", () => {
  writeSummon(db, {
    id: "mine-1",
    summoner_agent_id: "agent-S",
    target_username: "a",
    target_project: "pantheon",
    now: 100,
  });
  writeSummon(db, {
    id: "mine-2",
    summoner_agent_id: "agent-S",
    target_username: "b",
    target_project: "pantheon",
    now: 200,
  });
  writeSummon(db, {
    id: "other",
    summoner_agent_id: "agent-OTHER",
    target_username: "c",
    target_project: "pantheon",
    now: 150,
  });
  // Confirmed rows drop out of the pending set.
  confirmSummon(db, "mine-2", "child-b");

  const pending = pendingSummonsForSummoner(db, "agent-S");
  expect(pending.map((p) => p.id)).toEqual(["mine-1"]);
});

test("bumpSummonRetry increments retries and resets the boot window", () => {
  writeSummon(db, {
    id: "nonce-1",
    summoner_agent_id: "agent-S",
    target_username: "moth-whistle",
    target_project: "pantheon",
    now: 1_000,
  });
  bumpSummonRetry(db, "nonce-1", 5_000);
  const row = getSummon(db, "nonce-1")!;
  expect(row.retries).toBe(1);
  expect(row.spawned_at).toBe(5_000);
  expect(row.state).toBe("pending");
});

test("markSummonFailed makes the row terminal", () => {
  writeSummon(db, {
    id: "nonce-1",
    summoner_agent_id: "agent-S",
    target_username: "moth-whistle",
    target_project: "pantheon",
  });
  markSummonFailed(db, "nonce-1");
  expect(getSummon(db, "nonce-1")!.state).toBe("failed");
  // A failed row is no longer pending.
  expect(pendingSummonsForSummoner(db, "agent-S")).toHaveLength(0);
});

test("pruneStaleSummons drops rows older than the TTL by spawned_at", () => {
  const now = 10 * DEFAULT_SUMMON_TTL_MS;
  // Old confirmed row → pruned.
  writeSummon(db, {
    id: "old",
    summoner_agent_id: "agent-S",
    target_username: "a",
    target_project: "pantheon",
    now: now - DEFAULT_SUMMON_TTL_MS - 1,
  });
  confirmSummon(db, "old", "child-a", now - DEFAULT_SUMMON_TTL_MS - 1);
  // Fresh pending row mid-verification → kept.
  writeSummon(db, {
    id: "fresh",
    summoner_agent_id: "agent-S",
    target_username: "b",
    target_project: "pantheon",
    now: now - 1_000,
  });

  const dropped = pruneStaleSummons(db, DEFAULT_SUMMON_TTL_MS, now);
  expect(dropped).toBe(1);
  expect(getSummon(db, "old")).toBeNull();
  expect(getSummon(db, "fresh")).not.toBeNull();
});

test("a retried row keeps a fresh spawned_at and survives prune", () => {
  const now = 10 * DEFAULT_SUMMON_TTL_MS;
  writeSummon(db, {
    id: "retried",
    summoner_agent_id: "agent-S",
    target_username: "a",
    target_project: "pantheon",
    now: now - DEFAULT_SUMMON_TTL_MS - 5_000, // original spawn is old
  });
  bumpSummonRetry(db, "retried", now - 1_000); // but it was retried recently
  const dropped = pruneStaleSummons(db, DEFAULT_SUMMON_TTL_MS, now);
  expect(dropped).toBe(0);
  expect(getSummon(db, "retried")).not.toBeNull();
});
