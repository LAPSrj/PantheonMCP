import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openChatDb, CURRENT_SCHEMA_VERSION } from "../sqlite.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-sqlite-"));
  dbPath = path.join(tmpDir, "chat.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("openChatDb creates the file and applies v1 schema", () => {
  const db = openChatDb(dbPath);
  try {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("messages");
    expect(names).toContain("mentions");
    expect(names).toContain("schema_version");

    const v = db
      .query("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number };
    expect(v.v).toBe(CURRENT_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("openChatDb enables WAL + foreign_keys", () => {
  const db = openChatDb(dbPath);
  try {
    const journal = db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journal.journal_mode.toLowerCase()).toBe("wal");

    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  } finally {
    db.close();
  }
});

test("openChatDb is idempotent on a populated database", () => {
  let db = openChatDb(dbPath);
  db.run(
    "INSERT INTO messages (id, seq, ts, scope, from_agent_id, text) VALUES (?, ?, ?, ?, ?, ?)",
    ["m-1", 1, Date.now(), "project", "agent-1", "hi"],
  );
  db.close();

  db = openChatDb(dbPath);
  try {
    const count = db.query("SELECT COUNT(*) AS c FROM messages").get() as {
      c: number;
    };
    expect(count.c).toBe(1);

    // schema_version captures every applied migration. Re-opening
    // doesn't add new rows.
    const versions = db
      .query("SELECT version FROM schema_version ORDER BY version")
      .all() as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  } finally {
    db.close();
  }
});

test("messages.id is the primary key (duplicates rejected)", () => {
  const db = openChatDb(dbPath);
  try {
    db.run(
      "INSERT INTO messages (id, seq, ts, scope, from_agent_id, text) VALUES (?, ?, ?, ?, ?, ?)",
      ["m-1", 1, 1, "project", "a-1", "x"],
    );
    expect(() =>
      db.run(
        "INSERT INTO messages (id, seq, ts, scope, from_agent_id, text) VALUES (?, ?, ?, ?, ?, ?)",
        ["m-1", 2, 2, "project", "a-1", "y"],
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});

test("mentions cascades on message delete", () => {
  const db = openChatDb(dbPath);
  try {
    db.run(
      "INSERT INTO messages (id, seq, ts, scope, from_agent_id, text) VALUES (?, ?, ?, ?, ?, ?)",
      ["m-1", 1, 1, "project", "a-1", "x @vellumpike"],
    );
    db.run(
      "INSERT INTO mentions (message_id, mentioned_username) VALUES (?, ?)",
      ["m-1", "vellumpike"],
    );
    db.run("DELETE FROM messages WHERE id = ?", ["m-1"]);

    const remaining = db
      .query("SELECT COUNT(*) AS c FROM mentions")
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  } finally {
    db.close();
  }
});

test("from_transient defaults to 0 when omitted", () => {
  const db = openChatDb(dbPath);
  try {
    db.run(
      "INSERT INTO messages (id, seq, ts, scope, from_agent_id, text) VALUES (?, ?, ?, ?, ?, ?)",
      ["m-1", 1, 1, "project", "a-1", "x"],
    );
    const row = db
      .query("SELECT from_transient FROM messages WHERE id = ?")
      .get("m-1") as { from_transient: number };
    expect(row.from_transient).toBe(0);
  } finally {
    db.close();
  }
});
