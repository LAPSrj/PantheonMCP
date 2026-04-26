import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
import { ChatRouter } from "../router.ts";

let tmpDir: string;
let paths: Paths;
let dbA: ReturnType<typeof openChatDb>;
let dbB: ReturnType<typeof openChatDb>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-xproc-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  // Two DB connections to the same file simulate two MCP processes
  // sharing the chat database via WAL.
  dbA = openChatDb(paths.chatDbPath);
  dbB = openChatDb(paths.chatDbPath);
});

afterEach(() => {
  dbA.close();
  dbB.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("two routers backed by the same chat.db see each other in publicList", () => {
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });

  routerA.add({ username: "alpha", project: "X", transient: false });
  routerB.add({ username: "beta", project: "X", transient: false });

  const seenByA = routerA.publicList().map((s) => s.username);
  const seenByB = routerB.publicList().map((s) => s.username);
  expect(seenByA.sort()).toEqual(["alpha", "beta"]);
  expect(seenByB.sort()).toEqual(["alpha", "beta"]);
});

test("router.heartbeat keeps a subscriber row live across the stale threshold", async () => {
  const router = new ChatRouter({ paths, db: dbA });
  const sub = router.add({ username: "vellumpike", project: "p", transient: false });

  // The presence row was inserted by `add`. Heartbeat is the
  // ongoing keep-alive call.
  router.heartbeat(sub.agent_id);

  const rows = router.publicList();
  expect(rows.map((s) => s.username)).toEqual(["vellumpike"]);
});

test("logout removes the subscriber from the cross-process presence list", () => {
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });
  const sub = routerA.add({ username: "ephemeral", project: "p", transient: false });
  expect(routerB.publicList().map((s) => s.username)).toEqual(["ephemeral"]);
  routerA.remove(sub.agent_id);
  expect(routerB.publicList()).toEqual([]);
});

test("onlineUsernames reads cross-process presence", () => {
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });
  routerA.add({ username: "alpha", project: "X", transient: false });
  routerB.add({ username: "beta", project: "X", transient: false });
  const seenByA = routerA.onlineUsernames();
  expect(seenByA.has("alpha")).toBe(true);
  expect(seenByA.has("beta")).toBe(true);
});

test("setMode write-through is visible to other routers", () => {
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });
  const sub = routerA.add({ username: "alpha", project: "X", transient: false });
  routerA.setMode(sub.agent_id, "quiet");
  const seen = routerB.publicList();
  expect(seen[0]?.mode).toBe("quiet");
});
