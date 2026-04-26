import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Database } from "bun:sqlite";
import { openChatDb } from "../../storage/index.ts";
import { persistMessage, queryMessages } from "../persistence.ts";
import type { Message } from "../types.ts";

let tmpDir: string;
let db: Database;

function msg(over: Partial<Message> & Pick<Message, "id" | "from_agent_id" | "scope" | "text">): Message {
  return {
    seq: 1,
    ts: Date.now(),
    mentions: [],
    from_project: "test",
    from_username_inline: null,
    ...over,
  } as Message;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-chatdb-"));
  db = openChatDb(path.join(tmpDir, "chat.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("persistMessage writes the row + mentions inside a transaction", () => {
  persistMessage(
    db,
    msg({
      id: "m-1",
      from_agent_id: "agent-1",
      scope: "project",
      project: "pantheon",
      text: "hi @vellumpike @semaphoremole",
      mentions: ["vellumpike", "semaphoremole"],
    }),
  );
  const rows = db.query("SELECT * FROM messages").all() as { id: string; project: string; text: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.project).toBe("pantheon");
  const mentionRows = db.query("SELECT * FROM mentions ORDER BY mentioned_username").all() as { mentioned_username: string }[];
  expect(mentionRows.map((r) => r.mentioned_username)).toEqual(["semaphoremole", "vellumpike"]);
});

test("from_transient + from_username_inline persist for guest messages", () => {
  persistMessage(
    db,
    msg({
      id: "m-1",
      from_agent_id: "guest-agent",
      scope: "project",
      project: "p",
      text: "hi from a guest",
      from_username_inline: "leandro",
    }),
  );
  const row = db.query("SELECT * FROM messages WHERE id = ?").get("m-1") as {
    from_transient: number;
    from_username_inline: string;
  };
  expect(row.from_transient).toBe(1);
  expect(row.from_username_inline).toBe("leandro");
});

test("queryMessages filters by scope/project/since_ts and sorts ts DESC", () => {
  persistMessage(db, msg({ id: "old", from_agent_id: "a", scope: "project", project: "p", text: "old", ts: 100 }));
  persistMessage(db, msg({ id: "mid", from_agent_id: "a", scope: "project", project: "p", text: "mid", ts: 200 }));
  persistMessage(db, msg({ id: "new", from_agent_id: "a", scope: "project", project: "p", text: "new", ts: 300 }));
  persistMessage(db, msg({ id: "other", from_agent_id: "a", scope: "global", text: "other", ts: 250 }));

  const projectOnly = queryMessages(db, { scope: "project" });
  expect(projectOnly.map((r) => r.id)).toEqual(["new", "mid", "old"]);

  const sinceMid = queryMessages(db, { scope: "project", since_ts: 200 });
  expect(sinceMid.map((r) => r.id)).toEqual(["new"]);

  const limit2 = queryMessages(db, { limit: 2 });
  expect(limit2).toHaveLength(2);
  expect(limit2[0]!.id).toBe("new");
});

test("correlation_id stored from ask_id", () => {
  persistMessage(
    db,
    msg({
      id: "q1",
      from_agent_id: "a",
      scope: "dm",
      target: "b",
      text: "?",
      ask_id: "ask-abc",
    }),
  );
  const row = db.query("SELECT correlation_id FROM messages WHERE id = ?").get("q1") as { correlation_id: string };
  expect(row.correlation_id).toBe("ask-abc");
});
