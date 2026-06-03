import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
import { ChatRouter } from "../../chat/index.ts";
import { persistMessage } from "../../chat/persistence.ts";
import { readChatCursor } from "../../chat/presence.ts";
import type { Message } from "../../chat/types.ts";
import { runFetch } from "../fetch.ts";
import { EXIT_CODES } from "../exit-codes.ts";

/** Build a DM Message with a controlled `ts` and let persistMessage
 * assign the real seq (MAX+1). */
function dm(over: {
  id: string;
  from_agent_id: string;
  target: string;
  text: string;
  ts: number;
}): Message {
  return {
    seq: 0,
    scope: "dm",
    mentions: [],
    from_project: "X",
    from_username_inline: null,
    ...over,
  } as Message;
}

/** Run a --loop fetch, let it drain the initial batch, then abort and
 * return captured stdout. */
async function runLoopBriefly(
  paths: Paths,
  agent_id: string,
): Promise<{ code: number; out: string }> {
  const controller = new AbortController();
  const stdout = makeStream();
  const stderr = makeStream();
  const p = runFetch({
    args: ["--agent-id", agent_id, "--loop", "--wait", "50"],
    paths,
    stdout,
    stderr,
    signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 250));
  controller.abort();
  const code = await p;
  return { code, out: stdout.text };
}

let tmp: string;
let paths: Paths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-fetch-"));
  paths = resolvePaths({ PANTHEON_HOME: tmp } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface CapturedStream extends Writable {
  text: string;
}

function makeStream(): CapturedStream {
  const chunks: string[] = [];
  const s = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as CapturedStream;
  Object.defineProperty(s, "text", {
    get(): string {
      return chunks.join("");
    },
  });
  return s;
}

/** §11c presence-lapse recovery contract: both the startup-lookup-fail
 * path and the mid-loop SessionExpiredError path must converge on exit
 * code PRESENCE_LAPSED (3) and a single parseable stderr line led by
 * `pantheon-fetch: presence_lapsed agent_id=<id>` so agent harnesses
 * and shell wrappers can detect the condition deterministically. */
test("runFetch: no presence row at startup → exit 3 with parseable lapse line", async () => {
  const stderr = makeStream();
  const stdout = makeStream();
  // Touch the chat db so the open succeeds; no subscriber row inserted.
  openChatDb(paths.chatDbPath).close();

  const agent_id = "11111111-2222-3333-4444-555555555555";
  const code = await runFetch({
    args: ["--agent-id", agent_id],
    paths,
    stdout,
    stderr,
  });

  expect(code).toBe(EXIT_CODES.PRESENCE_LAPSED);
  expect(code).toBe(3);
  // Stable leading token + agent_id verbatim.
  expect(stderr.text).toContain(`pantheon-fetch: presence_lapsed agent_id=${agent_id}`);
  // Recovery clause points at the right tool.
  expect(stderr.text).toContain("mcp__pantheon__login");
  // No stray stdout chatter on the error path.
  expect(stdout.text).toBe("");
});

// --- watcher cursor-resume + 10-min replay cap (#5) ---

test("runFetch --loop: fresh subscriber (cursor stamped at login) streams NO backlog", async () => {
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  const sender = router.add({ username: "snd", project: "X", transient: false });
  // History exists BEFORE rcv logs in.
  persistMessage(db, dm({ id: "h1", from_agent_id: sender.agent_id, target: "rcv", text: "BACKLOG-1", ts: Date.now() - 1000 }));
  const rcv = router.add({ username: "rcv", project: "X", transient: false }); // cursor stamped to MAX
  db.close();

  const { code, out } = await runLoopBriefly(paths, rcv.agent_id);
  expect(code).toBe(EXIT_CODES.SUCCESS);
  // The cursor was stamped to MAX at login → the pre-existing message is
  // skipped from the stream (still in the DB / check_messages).
  expect(out).not.toContain("BACKLOG-1");
});

test("runFetch --loop: same-agent_id restart resumes from cursor, BUT the 10-min cap skips stale gap messages", async () => {
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  const sender = router.add({ username: "snd", project: "X", transient: false });
  // rcv logs in FIRST (cursor stamped to MAX=0), then gap messages arrive
  // while the stream's cursor stays at 0 (a watcher-down gap).
  const rcv = router.add({ username: "rcv", project: "X", transient: false });
  expect(readChatCursor(db, rcv.agent_id)).toBe(0);

  // One gap message INSIDE the 10-min window, one OUTSIDE it.
  persistMessage(db, dm({ id: "old", from_agent_id: sender.agent_id, target: "rcv", text: "GAP-OLD-15MIN", ts: Date.now() - 15 * 60 * 1000 }));
  persistMessage(db, dm({ id: "new", from_agent_id: sender.agent_id, target: "rcv", text: "GAP-NEW-5MIN", ts: Date.now() - 5 * 60 * 1000 }));
  // Both rows persisted and reachable regardless of the stream cap.
  const total = (db.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  expect(total).toBe(2);
  db.close();

  const { code, out } = await runLoopBriefly(paths, rcv.agent_id);
  expect(code).toBe(EXIT_CODES.SUCCESS);
  // Cursor=0 would replay BOTH without the cap; the cap clamps the resume
  // to the recent window — only the 5-min message streams.
  expect(out).toContain("GAP-NEW-5MIN");
  expect(out).not.toContain("GAP-OLD-15MIN");
});

test("runFetch --loop: advances chat_cursor as it emits (restart resumes past delivered messages)", async () => {
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  const sender = router.add({ username: "snd", project: "X", transient: false });
  const rcv = router.add({ username: "rcv", project: "X", transient: false });
  // A recent in-window message so the cap doesn't skip it.
  persistMessage(db, dm({ id: "e1", from_agent_id: sender.agent_id, target: "rcv", text: "EMIT-ME", ts: Date.now() - 1000 }));
  const seq = (db.query("SELECT MAX(seq) AS s FROM messages").get() as { s: number }).s;
  db.close();

  const { out } = await runLoopBriefly(paths, rcv.agent_id);
  expect(out).toContain("EMIT-ME");

  // Cursor advanced to the emitted seq → a same-agent_id restart resumes
  // past it (no re-emit).
  const db2 = openChatDb(paths.chatDbPath);
  expect(readChatCursor(db2, rcv.agent_id)).toBe(seq);
  db2.close();
});

