import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { dumpChat, rowsToJsonl } from "../dump-chat.ts";
import { loadChat } from "../load-chat.ts";
import { openChatDb, resolvePaths } from "../../storage/index.ts";
import { ChatRouter, upsertSubscriber } from "../../chat/index.ts";

let tmpDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-dump-load-"));
  env = { PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dumpChat → rowsToJsonl round-trips fields", () => {
  const paths = resolvePaths(env);
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  const a = router.add({ username: "alpha", project: "p", transient: false });
  const b = router.add({ username: "beta", project: "p", transient: false });
  router.addMessage({
    from_agent_id: a.agent_id,
    scope: "dm",
    target: "beta",
    text: "hi beta",
  });
  router.addMessage({
    from_agent_id: b.agent_id,
    scope: "project",
    text: "team chat @alpha",
  });
  db.close();

  const rows = dumpChat({ env });
  expect(rows.length).toBeGreaterThanOrEqual(2);
  // ts ASC for replay.
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i]!.ts >= rows[i - 1]!.ts).toBe(true);
  }
  // Round-trip via JSONL.
  const jsonl = rowsToJsonl(rows);
  expect(jsonl.endsWith("\n")).toBe(true);
  const parsed = jsonl
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  expect(parsed[0]?.id).toBe(rows[0]!.id);
});

test("dumpChat --since filters by ts", () => {
  const paths = resolvePaths(env);
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  const a = router.add({ username: "alpha", project: "p", transient: false });
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "early" });
  // Bump time so the next message has ts > 0 + 1.
  const beforeMid = Date.now();
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "later" });
  db.close();

  const rows = dumpChat({ env, since: beforeMid });
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows.every((r) => r.ts >= beforeMid)).toBe(true);
});

test("dumpChat --persona filters by sender / target / mention", () => {
  const paths = resolvePaths(env);
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  const a = router.add({ username: "alpha", project: "p", transient: false });
  const b = router.add({ username: "beta", project: "p", transient: false });
  // alpha → general
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "alpha says hi" });
  // beta → DM alpha
  router.addMessage({ from_agent_id: b.agent_id, scope: "dm", target: "alpha", text: "psst" });
  // beta → mentions alpha
  router.addMessage({ from_agent_id: b.agent_id, scope: "project", text: "ping @alpha" });
  // gamma → unrelated
  const c = router.add({ username: "gamma", project: "p", transient: false });
  router.addMessage({ from_agent_id: c.agent_id, scope: "project", text: "unrelated" });
  db.close();

  const rows = dumpChat({ env, persona: "alpha" });
  const texts = rows.map((r) => r.text);
  expect(texts).toContain("alpha says hi");
  expect(texts).toContain("psst");
  expect(texts).toContain("ping @alpha");
  expect(texts).not.toContain("unrelated");
});

test("loadChat re-imports a JSONL file; SQLite assigns fresh seqs; preserves id/ts", () => {
  const paths = resolvePaths(env);
  // Seed a source DB.
  const sourceDb = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db: sourceDb });
  const a = router.add({ username: "alpha", project: "p", transient: false });
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "first" });
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "second" });
  sourceDb.close();

  const rows = dumpChat({ env });
  expect(rows.length).toBeGreaterThanOrEqual(2);
  const dumpFile = path.join(tmpDir, "out.jsonl");
  fs.writeFileSync(dumpFile, rowsToJsonl(rows));

  // Wipe target DB and re-import. Fresh PANTHEON_HOME.
  const tgtDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-load-target-"));
  try {
    const tgtEnv = { PANTHEON_HOME: tgtDir } as NodeJS.ProcessEnv;
    const result = loadChat({ file: dumpFile, env: tgtEnv });
    expect(result.loaded).toBe(rows.length);
    expect(result.skipped_duplicate).toBe(0);
    expect(result.errors).toEqual([]);

    // Re-import again — every row should be skipped as duplicate.
    const second = loadChat({ file: dumpFile, env: tgtEnv });
    expect(second.loaded).toBe(0);
    expect(second.skipped_duplicate).toBe(rows.length);

    // Fields preserved.
    const tgtPaths = resolvePaths(tgtEnv);
    const tgtDb = openChatDb(tgtPaths.chatDbPath);
    try {
      const persisted = tgtDb
        .query("SELECT id, ts, text, seq FROM messages ORDER BY seq ASC")
        .all() as { id: string; ts: number; text: string; seq: number }[];
      // Same set of texts (compare sets — same-ms ts collisions can
      // permute the order).
      expect(new Set(persisted.map((p) => p.text))).toEqual(new Set(rows.map((r) => r.text)));
      // SQLite assigned fresh monotonic seqs starting at 1.
      expect(persisted.map((p) => p.seq)).toEqual([1, 2]);
    } finally {
      tgtDb.close();
    }
  } finally {
    fs.rmSync(tgtDir, { recursive: true, force: true });
  }
});

test("loadChat --dry-run validates without inserting", () => {
  const paths = resolvePaths(env);
  // Open the DB so chat.db exists with current schema; never insert.
  const db = openChatDb(paths.chatDbPath);
  db.close();

  const file = path.join(tmpDir, "in.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: "x1",
      ts: Date.now(),
      scope: "project",
      from_agent_id: "agent-1",
      text: "hi",
    }) + "\n",
  );
  const result = loadChat({ file, dry_run: true, env });
  expect(result.errors).toEqual([]);
  // Nothing in the DB.
  const db2 = openChatDb(paths.chatDbPath);
  const count = (db2.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  db2.close();
  expect(count).toBe(0);
});

test("loadChat reports invalid lines without aborting", () => {
  const paths = resolvePaths(env);
  const db = openChatDb(paths.chatDbPath);
  db.close();

  const file = path.join(tmpDir, "mixed.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ id: "ok", ts: 1, scope: "project", from_agent_id: "a", text: "good" }),
      "{not json}",
      JSON.stringify({ ts: 2, scope: "project", from_agent_id: "a", text: "no id" }),
    ].join("\n") + "\n",
  );
  const result = loadChat({ file, env });
  expect(result.loaded).toBe(1);
  expect(result.skipped_invalid).toBe(2);
  expect(result.errors.length).toBe(2);
});

test("loadChat: missing file surfaces an error, not a throw", () => {
  const result = loadChat({ file: path.join(tmpDir, "ghost.jsonl"), env });
  expect(result.loaded).toBe(0);
  expect(result.errors[0]).toContain("File not found");
  // Suppress unused import warnings.
  void upsertSubscriber;
});
