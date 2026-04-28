import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Database } from "bun:sqlite";
import { openChatDb } from "../../storage/index.ts";
import { persistMessage } from "../persistence.ts";
import { upsertSubscriber } from "../presence.ts";
import {
  isDeliverableRow,
  isVisibleRow,
  readMaxSeq,
  selectReceivableRows,
  tailOnce,
  type ReceiverState,
} from "../watcher.ts";
import type { Message, Subscriber, SystemKind } from "../types.ts";

let tmpDir: string;
let db: Database;

const me: ReceiverState = {
  agent_id: "me",
  username: "vellumpike",
  project: "pantheon",
  mode: "all",
};

function msg(over: Partial<Message> & Pick<Message, "id" | "seq" | "from_agent_id" | "scope" | "text">): Message {
  return {
    ts: 1_000_000 + over.seq * 1000,
    mentions: [],
    from_project: "pantheon",
    from_username_inline: null,
    ...over,
  } as Message;
}

function sub(over: Partial<Subscriber> & { agent_id: string; username: string }): Subscriber {
  return {
    transient: false,
    project: "pantheon",
    status: "",
    mode: "all",
    connected_at: 0,
    last_seen: 0,
    last_event_at: 0,
    status_updated_at: 0,
    promoted_at: null,
    ...over,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-watcher-"));
  db = openChatDb(path.join(tmpDir, "chat.db"));
  upsertSubscriber(db, sub({ agent_id: "me", username: "vellumpike", project: "pantheon" }));
  upsertSubscriber(db, sub({ agent_id: "peer", username: "moth-whistle", project: "pantheon" }));
  upsertSubscriber(db, sub({ agent_id: "outsider", username: "yapsmith", project: "other" }));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- visibility ---

test("isVisibleRow: global reaches everyone", () => {
  const row = msg({ id: "g", seq: 1, from_agent_id: "peer", scope: "global", text: "all hands" });
  persistMessage(db, row);
  const r = (db.query("SELECT * FROM messages WHERE id = ?").get("g")) as never;
  expect(isVisibleRow(r, me)).toBe(true);
});

test("isVisibleRow: project filters by project", () => {
  persistMessage(db, msg({ id: "p", seq: 1, from_agent_id: "peer", scope: "project", text: "team", project: "pantheon" }));
  const r = (db.query("SELECT * FROM messages WHERE id = ?").get("p")) as never;
  expect(isVisibleRow(r, me)).toBe(true);
  // Cross-project message — invisible.
  persistMessage(db, msg({ id: "x", seq: 2, from_agent_id: "outsider", scope: "project", text: "other team", project: "other" }));
  const x = (db.query("SELECT * FROM messages WHERE id = ?").get("x")) as never;
  expect(isVisibleRow(x, me)).toBe(false);
});

test("isVisibleRow: dm visible only to the target", () => {
  persistMessage(db, msg({ id: "d", seq: 1, from_agent_id: "peer", scope: "dm", target: "vellumpike", text: "psst" }));
  const r = (db.query("SELECT * FROM messages WHERE id = ?").get("d")) as never;
  expect(isVisibleRow(r, me)).toBe(true);
  expect(isVisibleRow(r, { ...me, username: "moth-whistle" })).toBe(false);
});

// --- deliverability / mode ---

test("isDeliverableRow: quiet drops system events but keeps personal", () => {
  const join = msg({
    id: "j",
    seq: 1,
    from_agent_id: "system",
    scope: "project",
    text: "alpha joined",
    project: "pantheon",
    system: true,
    system_kind: "join" as SystemKind,
  });
  persistMessage(db, join);
  const r = (db.query("SELECT * FROM messages WHERE id = ?").get("j")) as never;
  expect(isDeliverableRow(r, { ...me, mode: "quiet" }, new Set())).toBe(false);
});

test("isDeliverableRow: dm-mode keeps DMs and mentions, drops chatter", () => {
  const dm = msg({ id: "d", seq: 1, from_agent_id: "peer", scope: "dm", target: "vellumpike", text: "ping" });
  const chatter = msg({ id: "c", seq: 2, from_agent_id: "peer", scope: "project", text: "general talk", project: "pantheon" });
  const mention = msg({ id: "m", seq: 3, from_agent_id: "peer", scope: "project", text: "hey @vellumpike", project: "pantheon", mentions: ["vellumpike"] });
  persistMessage(db, dm);
  persistMessage(db, chatter);
  persistMessage(db, mention);

  const dmRow = (db.query("SELECT * FROM messages WHERE id = ?").get("d")) as never;
  const chRow = (db.query("SELECT * FROM messages WHERE id = ?").get("c")) as never;
  const mnRow = (db.query("SELECT * FROM messages WHERE id = ?").get("m")) as never;

  expect(isDeliverableRow(dmRow, { ...me, mode: "dm" }, new Set())).toBe(true);
  expect(isDeliverableRow(chRow, { ...me, mode: "dm" }, new Set())).toBe(false);
  // Mention bypass: the watcher's selectReceivableRows joins the
  // mentions table; here we pass it explicitly.
  expect(isDeliverableRow(mnRow, { ...me, mode: "dm" }, new Set(["m"]))).toBe(true);
});

// --- selectReceivableRows + cursor ---

test("selectReceivableRows skips messages from self and respects since_seq", () => {
  persistMessage(db, msg({ id: "self", seq: 1, from_agent_id: "me", scope: "project", text: "from self", project: "pantheon" }));
  persistMessage(db, msg({ id: "a", seq: 2, from_agent_id: "peer", scope: "project", text: "first", project: "pantheon" }));
  persistMessage(db, msg({ id: "b", seq: 3, from_agent_id: "peer", scope: "project", text: "second", project: "pantheon" }));

  const allReceivable = selectReceivableRows({ db, receiver: me, since_seq: 0 });
  expect(allReceivable.map((r) => r.id)).toEqual(["a", "b"]);

  const sinceA = selectReceivableRows({ db, receiver: me, since_seq: 2 });
  expect(sinceA.map((r) => r.id)).toEqual(["b"]);
});

// --- formatBatch + priority tags + silent wrapper ---

test("formatBatch: directed messages get bracket priority tags", () => {
  persistMessage(db, msg({ id: "dm", seq: 1, from_agent_id: "peer", scope: "dm", target: "vellumpike", text: "ping" }));
  persistMessage(db, msg({ id: "ask", seq: 2, from_agent_id: "peer", scope: "dm", target: "vellumpike", text: "?", ask_id: "corr-1" }));
  persistMessage(db, msg({ id: "men", seq: 3, from_agent_id: "peer", scope: "project", text: "@vellumpike yo", project: "pantheon", mentions: ["vellumpike"] }));

  const events = tailOnce({ db, receiver: me, since_seq: 0 });
  const lines = events.map((e) => e.line);
  expect(lines.find((l) => l.includes("[likely reply]"))).toBeDefined();
  expect(lines.find((l) => l.includes("[required reply]"))).toBeDefined();
  expect(lines.find((l) => l.includes("[maybe reply]"))).toBeDefined();
});

test("formatBatch: silent events get coalesced into a single <silent-event> line", () => {
  persistMessage(db, msg({ id: "j1", seq: 1, from_agent_id: "system", scope: "project", text: "alpha joined", project: "pantheon", system: true, system_kind: "join" as SystemKind }));
  persistMessage(db, msg({ id: "j2", seq: 2, from_agent_id: "system", scope: "project", text: "beta joined", project: "pantheon", system: true, system_kind: "join" as SystemKind }));
  persistMessage(db, msg({ id: "l1", seq: 3, from_agent_id: "system", scope: "project", text: "gamma left", project: "pantheon", system: true, system_kind: "leave" as SystemKind }));

  const events = tailOnce({ db, receiver: me, since_seq: 0 });
  expect(events).toHaveLength(1);
  expect(events[0]!.line).toContain("<silent-event");
  expect(events[0]!.line).toContain("count=3");
  expect(events[0]!.line).toContain("2× join");
  expect(events[0]!.line).toContain("1× leave");
  expect(events[0]!.message_ids).toEqual(["j1", "j2", "l1"]);
});

test("formatBatch: oversized message body is replaced with a get_message stub", () => {
  const longText = "x".repeat(2000); // > default 1500 threshold
  persistMessage(
    db,
    msg({
      id: "big",
      seq: 1,
      from_agent_id: "peer",
      scope: "dm",
      target: "vellumpike",
      text: longText,
    }),
  );
  const events = tailOnce({ db, receiver: me, since_seq: 0 });
  expect(events).toHaveLength(1);
  const line = events[0]!.line;
  // Stub names the sender, the original size, and the exact tool call.
  // (test fixture uses agent_id "peer" — senderHandle emits
  // "agent:peer" since no inline username is set; in production the
  // sender resolves to the real username via from_username_inline or
  // a presence lookup at format time.)
  expect(line).toContain("[oversized message from agent:peer");
  expect(line).toContain("original 2000 chars");
  expect(line).toContain('mcp__pantheon__get_message({ message_id: "big" })');
  // Original text is NOT in the emitted line.
  expect(line.includes(longText)).toBe(false);
  // message_ids still surfaces the row id so callers can correlate.
  expect(events[0]!.message_ids).toEqual(["big"]);
});

test("formatBatch: messages at or below threshold pass through unchanged", () => {
  const fits = "y".repeat(1500); // exactly the default threshold
  persistMessage(
    db,
    msg({
      id: "fits",
      seq: 1,
      from_agent_id: "peer",
      scope: "dm",
      target: "vellumpike",
      text: fits,
    }),
  );
  const events = tailOnce({ db, receiver: me, since_seq: 0 });
  expect(events[0]!.line).toContain(fits);
  expect(events[0]!.line.includes("[oversized message")).toBe(false);
});

test("formatBatch: PANTHEON_WATCHER_TRUNCATE_AT env override changes the threshold", () => {
  const prev = process.env.PANTHEON_WATCHER_TRUNCATE_AT;
  process.env.PANTHEON_WATCHER_TRUNCATE_AT = "10";
  try {
    persistMessage(
      db,
      msg({
        id: "small",
        seq: 1,
        from_agent_id: "peer",
        scope: "dm",
        target: "vellumpike",
        text: "this is more than ten chars",
      }),
    );
    const events = tailOnce({ db, receiver: me, since_seq: 0 });
    expect(events[0]!.line).toContain("[oversized message");
    expect(events[0]!.line).toContain('message_id: "small"');
  } finally {
    if (prev === undefined) delete process.env.PANTHEON_WATCHER_TRUNCATE_AT;
    else process.env.PANTHEON_WATCHER_TRUNCATE_AT = prev;
  }
});

test("formatBatch: silent events flushed before a directed message", () => {
  persistMessage(db, msg({ id: "j1", seq: 1, from_agent_id: "system", scope: "project", text: "alpha joined", project: "pantheon", system: true, system_kind: "join" as SystemKind }));
  persistMessage(db, msg({ id: "dm", seq: 2, from_agent_id: "peer", scope: "dm", target: "vellumpike", text: "hi" }));
  persistMessage(db, msg({ id: "j2", seq: 3, from_agent_id: "system", scope: "project", text: "beta joined", project: "pantheon", system: true, system_kind: "join" as SystemKind }));

  const events = tailOnce({ db, receiver: me, since_seq: 0 });
  expect(events).toHaveLength(3);
  expect(events[0]!.line).toContain("<silent-event");
  expect(events[1]!.line).toContain("[likely reply]");
  expect(events[2]!.line).toContain("<silent-event");
});

test("formatBatch: status_digest gets [no reply] tag and `· status_digest` label, NOT silent-event wrapped", () => {
  // Per Yapsmith's revamp: status_digest is itself a digest, so it
  // does NOT get the silent-event wrapping (would be double-batching)
  // and the priority tag is forced to [no reply] (ambient).
  persistMessage(db, msg({
    id: "sd",
    seq: 1,
    from_agent_id: "system",
    scope: "dm",
    target: "vellumpike",
    text: "status_digest — 1 agent changed status\n[pantheon]\n  alpha — deep work",
    system: true,
    system_kind: "status_digest" as SystemKind,
  }));
  const events = tailOnce({ db, receiver: me, since_seq: 0 });
  expect(events).toHaveLength(1);
  const line = events[0]!.line;
  expect(line).toContain("[no reply]");
  expect(line).toContain("· status_digest");
  expect(line).toContain("alpha — deep work");
  expect(line).not.toContain("<silent-event");
  // Despite being scope=dm to me, the tag is NOT [likely reply]
  // (which is what a regular DM would get) — status_digest overrides.
  expect(line).not.toContain("[likely reply]");
});

// --- readMaxSeq ---

test("readMaxSeq returns the largest seq, or 0 when empty", () => {
  expect(readMaxSeq(db)).toBe(0);
  // Caller-supplied seq is overridden by SQLite's MAX(seq)+1 — that's
  // the cross-process safety guarantee. So persisted seqs are always
  // the next monotonic integer regardless of input.
  persistMessage(db, msg({ id: "a", seq: 99, from_agent_id: "peer", scope: "project", text: "x", project: "pantheon" }));
  persistMessage(db, msg({ id: "b", seq: 99, from_agent_id: "peer", scope: "project", text: "y", project: "pantheon" }));
  expect(readMaxSeq(db)).toBe(2);
});

test("persistMessage assigns SQLite-managed seq even across two connections", async () => {
  // Reuse the same chat.db file via a second connection — simulates
  // two MCP processes writing concurrently.
  const { openChatDb } = await import("../../storage/index.ts");
  const dbB = openChatDb(path.join(tmpDir, "chat.db"));
  try {
    persistMessage(db, msg({ id: "a", seq: 100, from_agent_id: "peer", scope: "project", text: "from db1", project: "pantheon" }));
    persistMessage(dbB, msg({ id: "b", seq: 100, from_agent_id: "peer", scope: "project", text: "from db2", project: "pantheon" }));
    persistMessage(db, msg({ id: "c", seq: 100, from_agent_id: "peer", scope: "project", text: "back to db1", project: "pantheon" }));

    const rows = db
      .query("SELECT id, seq FROM messages ORDER BY seq ASC")
      .all() as { id: string; seq: number }[];
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  } finally {
    dbB.close();
  }
});

test("formatBatch: structured message renders [kind:X] suffix and persists payload", () => {
  persistMessage(
    db,
    msg({
      id: "s1",
      seq: 1,
      from_agent_id: "peer",
      scope: "project",
      project: "pantheon",
      text: "[pushback]",
      user_kind: "pushback",
      payload: { pattern: 14, evidence: { file: "a.ts", line: 89 } },
    }),
  );
  const events = tailOnce({ db, receiver: me, since_seq: 0 });
  expect(events).toHaveLength(1);
  expect(events[0]!.line).toContain("[kind:pushback]");
  expect(events[0]!.line).toContain("[pushback]");

  const row = db
    .query("SELECT user_kind, payload FROM messages WHERE id = ?")
    .get("s1") as { user_kind: string; payload: string };
  expect(row.user_kind).toBe("pushback");
  expect(JSON.parse(row.payload)).toEqual({
    pattern: 14,
    evidence: { file: "a.ts", line: 89 },
  });
});
