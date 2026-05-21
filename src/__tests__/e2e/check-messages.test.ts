import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";
import { readChatCursor } from "../../chat/index.ts";

let fix: E2EFixture;

beforeEach(() => {
  fix = makeFixture();
});

afterEach(() => {
  fix.cleanup();
});

test("cross-process: procB's check_messages sees DMs from procA", async () => {
  // Both register + claim + login chat.
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/a",
    claim_after: true,
  });
  await call(fix.procB, "register", {
    username: "beta",
    project: "pantheon",
    cwd: "/b",
    claim_after: true,
  });
  await call(fix.procA, "login", { username: "alpha", project: "pantheon", transient: false });
  const loginB = await call(fix.procB, "login", { username: "beta", project: "pantheon", transient: false });

  // procA writes 5 DMs to beta.
  for (let i = 1; i <= 5; i++) {
    await call(fix.procA, "send_message", {
      text: `dm ${i}`,
      scope: "dm",
      target: "beta",
    });
  }

  // procB's first check_messages returns all 5 DMs (filtering past
  // the system join events that B's mode=all doesn't drop).
  const first = await call(fix.procB, "check_messages");
  const dms = (first.payload.messages as Array<{ text: string; scope: string }>)
    .filter((m) => m.scope === "dm")
    .map((m) => m.text);
  expect(dms).toEqual(["dm 1", "dm 2", "dm 3", "dm 4", "dm 5"]);

  // Cursor advanced. Second call returns empty.
  const second = await call(fix.procB, "check_messages");
  expect(second.payload.count).toBe(0);

  // Cursor persisted on the SQLite presence row.
  const cursor = readChatCursor(fix.procB.db, loginB.payload.agent_id as string);
  expect(cursor).toBeGreaterThan(0);
});

test("cross-process: cursor reset after disconnect (full backlog on rejoin)", async () => {
  await call(fix.procA, "register", { username: "alpha", project: "p", cwd: "/a", claim_after: true });
  await call(fix.procB, "register", { username: "beta", project: "p", cwd: "/b", claim_after: true });
  await call(fix.procA, "login", { username: "alpha", project: "p", transient: false });
  await call(fix.procB, "login", { username: "beta", project: "p", transient: false });

  // procA writes a project-scoped message visible to all project-p
  // members (including beta while she's online). No `target` on a
  // project broadcast — the inverse-guard rejects target on non-dm
  // sends.
  await call(fix.procA, "send_message", {
    text: "before logout",
    scope: "project",
  });

  // beta logs out (subscribers row deleted; cursor goes with it).
  await call(fix.procB, "logout");

  // procA writes another project-scoped message after beta is gone.
  // (DM-to-offline-target now fails by design; project scope persists
  // for everyone in the project regardless of who's online, which is
  // the right vehicle for testing cursor-reset semantics.)
  await call(fix.procA, "send_message", {
    text: "after logout",
    scope: "project",
  });

  // beta logs in again — fresh agent_id, cursor starts at 0, sees backlog.
  await call(fix.procB, "login", { username: "beta", project: "p", transient: false });
  const r = await call(fix.procB, "check_messages");
  const projectMsgs = (r.payload.messages as Array<{ text: string; scope: string }>)
    .filter((m) => m.scope === "project")
    .map((m) => m.text);
  // Both messages should be visible (project membership matches, and
  // beta's agent_id is fresh so cursor starts at 0 → full backlog).
  expect(projectMsgs).toContain("before logout");
  expect(projectMsgs).toContain("after logout");
});

test("cross-process: mention bypass — DM mode receives @mention via check_messages", async () => {
  await call(fix.procA, "register", { username: "alpha", project: "p", cwd: "/a", claim_after: true });
  await call(fix.procB, "register", { username: "beta", project: "p", cwd: "/b", claim_after: true });
  await call(fix.procA, "login", { username: "alpha", project: "p", transient: false });
  await call(fix.procB, "login", { username: "beta", project: "p", transient: false });
  // beta switches to dm mode (drops project chatter).
  await call(fix.procB, "set_mode", { mode: "dm" });

  // procA broadcasts a project message that mentions beta.
  await call(fix.procA, "send_message", { text: "general chatter @beta look here" });

  // beta's check_messages should include the @-mentioned message even
  // though mode=dm normally drops project chatter (mention bypass).
  const r = await call(fix.procB, "check_messages");
  const projectMessages = (r.payload.messages as Array<{ text: string; scope: string }>).filter(
    (m) => m.scope === "project" && m.text.includes("@beta"),
  );
  expect(projectMessages).toHaveLength(1);
});

test("cross-process: cursor preserved across heartbeats (ON CONFLICT)", async () => {
  await call(fix.procA, "register", { username: "alpha", project: "p", cwd: "/a", claim_after: true });
  await call(fix.procB, "register", { username: "beta", project: "p", cwd: "/b", claim_after: true });
  await call(fix.procA, "login", { username: "alpha", project: "p", transient: false });
  const loginB = await call(fix.procB, "login", { username: "beta", project: "p", transient: false });

  await call(fix.procA, "send_message", { text: "msg 1", scope: "dm", target: "beta" });
  await call(fix.procB, "check_messages");
  const cursorBefore = readChatCursor(fix.procB.db, loginB.payload.agent_id as string);
  expect(cursorBefore).toBeGreaterThan(0);

  // Simulate a heartbeat (which goes through router.heartbeat → SQLite UPDATE).
  fix.procB.ctx.chat!.heartbeat(loginB.payload.agent_id as string);

  // Trigger a setMode to exercise upsertSubscriber's ON CONFLICT path.
  await call(fix.procB, "set_mode", { mode: "quiet" });

  const cursorAfter = readChatCursor(fix.procB.db, loginB.payload.agent_id as string);
  expect(cursorAfter).toBe(cursorBefore);
});
