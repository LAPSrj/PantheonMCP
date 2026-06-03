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

test("clones annotation works on the SQLite (cross-process) publicList path", () => {
  // Canonical lives in process A; suffixed siblings in process B. The
  // SQLite presence path must still annotate the canonical entry.
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });
  routerA.add({ username: "righthand", project: "X", transient: false });
  routerB.add({ username: "righthand2", project: "X", transient: false });
  routerB.add({ username: "righthand4", project: "X", transient: false });

  const list = routerA.publicList();
  expect(list.find((a) => a.username === "righthand")?.clones).toEqual([
    "righthand2",
    "righthand4",
  ]);
  expect(list.find((a) => a.username === "righthand2")?.clones).toBeUndefined();
  // liveSiblings reads the same cross-process snapshot.
  expect(routerA.liveSiblings("righthand").map((s) => s.username)).toEqual([
    "righthand",
    "righthand2",
    "righthand4",
  ]);
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

test("router.heartbeat self-heals when the row was pruned and no sibling holds the handle", () => {
  // Scenario: this MCP process napped (computer sleep / long pause) past
  // the prune grace; another live MCP's daemon-tick ran `pruneStale` and
  // dropped our row. The in-memory subscriber map still has us; no one
  // else has taken our canonical handle. When the heartbeat tick fires
  // again it must re-insert the row so peers' `list_agents` / DM
  // routing see us as live without forcing the agent to re-login.
  const router = new ChatRouter({ paths, db: dbA });
  const sub = router.add({ username: "vellumpike", project: "p", transient: false });

  // Simulate the prune: drop the row directly from SQLite. Router's
  // in-memory `subscribers` map is untouched.
  dbA.run("DELETE FROM subscribers WHERE agent_id = ?", [sub.agent_id]);
  expect(router.publicList()).toEqual([]);

  router.heartbeat(sub.agent_id);

  expect(router.publicList().map((s) => s.username)).toEqual(["vellumpike"]);
});

test("router.heartbeat does NOT self-heal when a sibling has taken the canonical handle", () => {
  // Scenario: process A is `vellumpike` (agent_id X1). A's row gets
  // pruned during a long lapse. While A was gone, sibling-incarnation
  // B legitimately took the canonical `vellumpike` handle under a new
  // agent_id X2. When A's heartbeat tick eventually fires, self-heal
  // must SKIP — re-inserting A's row would duplicate `vellumpike` in
  // SQLite. The agent's next `login` will auto-suffix correctly.
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });

  const subA = routerA.add({ username: "vellumpike", project: "p", transient: false });
  // Prune A's row, then B takes the canonical name.
  dbA.run("DELETE FROM subscribers WHERE agent_id = ?", [subA.agent_id]);
  routerB.add({ username: "vellumpike", project: "p", transient: false });

  // A's heartbeat fires. Self-heal must abstain.
  routerA.heartbeat(subA.agent_id);

  const rows = routerB.publicList();
  expect(rows.length).toBe(1);
  expect(rows[0]?.username).toBe("vellumpike");
  // Only B's row exists; A's is still absent. Check SQLite directly
  // since publicList collapses by username — the duplicate-row failure
  // mode we're guarding against would show up as 2 SQLite rows.
  const sqliteRows = dbA
    .query("SELECT agent_id FROM subscribers WHERE username = ?")
    .all("vellumpike") as Array<{ agent_id: string }>;
  expect(sqliteRows.length).toBe(1);
  expect(sqliteRows[0]?.agent_id).not.toBe(subA.agent_id);
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

test("cross-process collision: second router cannot add the same username", () => {
  // Regression for the duplicate-`semaphoremole` chat bug. Each MCP
  // process has its own ChatRouter with its own in-memory subscriber
  // map. Without consulting the cross-process `subscribers` table,
  // the second login passed availability and both ended up chatting
  // under the same name.
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });
  routerA.add({ username: "semaphoremole", project: "liaison", transient: false });
  expect(() =>
    routerB.add({ username: "semaphoremole", project: "liaison", transient: false }),
  ).toThrow(/username_taken|subscriber_taken/);
});

test("cross-process collision: claimed_persona owner still blocked when peer is online", () => {
  // Even when the second login is a registered persona-owner asking
  // to chat as itself, the cross-process collision still fires —
  // there's already a peer logged in under the same handle. The
  // remediation lives at the MCP login-handler layer (suggested
  // suffix), not the router.
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });
  routerA.add({
    username: "semaphoremole",
    project: "liaison",
    transient: false,
    claimed_persona: "semaphoremole",
  });
  expect(() =>
    routerB.add({
      username: "semaphoremole",
      project: "liaison",
      transient: false,
      claimed_persona: "semaphoremole",
    }),
  ).toThrow(/username_taken|subscriber_taken/);
});

test("sweepInMemoryOrphans drops in-memory subscribers whose presence row was pruned", () => {
  // Simulate a long-running MCP process whose in-memory subscriber
  // map outlived the subscriber's SQLite presence row (the original
  // stuck-canonical-handle bug shape: one /compact left an orphan
  // entry in router.subscribers because the chat handler swapped
  // chat_agent_id without calling `remove`).
  let now = 1_000_000;
  const router = new ChatRouter({ paths, db: dbA, clock: () => now });
  const sub = router.add({
    username: "ghost",
    project: "p",
    transient: false,
  });
  // Subscriber is fresh — sweep is a no-op.
  expect(router.sweepInMemoryOrphans()).toBe(0);
  expect(router.getByUsername("ghost")?.agent_id).toBe(sub.agent_id);

  // Manually delete the SQLite presence row to simulate a heartbeat
  // dying off + the 60s prune window having passed (pruneStale ran).
  // The in-memory subscriber is now an orphan.
  dbA.run("DELETE FROM subscribers WHERE agent_id = ?", [sub.agent_id]);
  expect(router.sweepInMemoryOrphans()).toBe(1);
  // In-memory map is also empty now — the canonical handle is reclaimable.
  expect(router.getByUsername("ghost")).toBeNull();
});

test("sweepInMemoryOrphans is a no-op for fresh subscribers", () => {
  let now = 1_000_000;
  const router = new ChatRouter({ paths, db: dbA, clock: () => now });
  router.add({ username: "alive", project: "p", transient: false });
  // Time has not advanced past the prune grace; presence row is fresh.
  expect(router.sweepInMemoryOrphans()).toBe(0);
  expect(router.getByUsername("alive")).not.toBeNull();
});

test("sweepInMemoryOrphans uses prune_grace_ms to decide staleness", () => {
  let now = 1_000_000;
  const router = new ChatRouter({ paths, db: dbA, clock: () => now });
  router.add({ username: "creep", project: "p", transient: false });
  // Advance the clock past the 60s default; the SQLite row's
  // last_heartbeat (set at add-time = now=1_000_000) is now stale.
  now += 90_000;
  // The SQLite row hasn't been pruned by pruneStale yet, but
  // sweepInMemoryOrphans's filter (last_heartbeat > now - grace) will
  // miss it. We treat that as orphaned-equivalent.
  expect(router.sweepInMemoryOrphans()).toBe(1);
  expect(router.getByUsername("creep")).toBeNull();
});

test("sweepInMemoryOrphans is a no-op when no db is wired", () => {
  // Test routers without persistence (in-memory-only) don't need the
  // sweep — there's no SQLite row to compare against. The method
  // returns 0 without touching the in-memory map.
  const router = new ChatRouter({ paths });
  router.add({ username: "transient", project: "p", transient: false });
  expect(router.sweepInMemoryOrphans()).toBe(0);
  expect(router.getByUsername("transient")).not.toBeNull();
});

test("cross-process suffix-walk skips peer-owned handles", () => {
  // `nextAvailableIncarnation("alice")` must skip `alice2` if a peer
  // is already chatting as `alice2`, returning `alice3`.
  const routerA = new ChatRouter({ paths, db: dbA });
  const routerB = new ChatRouter({ paths, db: dbB });
  routerA.add({ username: "alice", project: "p", transient: false });
  routerA.add({ username: "alice2", project: "p", transient: false });
  const next = routerB.nextAvailableIncarnation("alice");
  expect(next).toBe("alice3");
});
