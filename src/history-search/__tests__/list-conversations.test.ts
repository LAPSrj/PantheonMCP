import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_LIST_CONVERSATIONS_LIMIT,
  CONVERSATION_PREVIEW_MAX_CHARS,
  listConversations,
  listConversationsMulti,
  encodeCwdForClaudeProject,
} from "../index.ts";

let tmpDir: string;
let projectsRoot: string;
let sessionDir: string;
let personaCwd: string;

function writeJsonl(name: string, records: unknown[], mtimeMs?: number): string {
  const filePath = path.join(sessionDir, `${name}.jsonl`);
  fs.writeFileSync(
    filePath,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  if (mtimeMs !== undefined) {
    const t = mtimeMs / 1000;
    fs.utimesSync(filePath, t, t);
  }
  return filePath;
}

const userMsg = (content: unknown, timestamp?: string) => ({
  type: "user",
  message: { content },
  ...(timestamp ? { timestamp } : {}),
});
const asstMsg = (text: string, timestamp?: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
  ...(timestamp ? { timestamp } : {}),
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-listconvo-"));
  projectsRoot = path.join(tmpDir, ".claude", "projects");
  personaCwd = "/work/alpha";
  sessionDir = path.join(projectsRoot, encodeCwdForClaudeProject(personaCwd));
  fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("missing project dir returns empty", () => {
  const res = listConversations({
    cwd: "/work/nonexistent",
    claudeProjectsRoot: projectsRoot,
  });
  expect(res).toEqual({ conversations: [], total: 0, truncated: false });
});

test("lists conversations most-recently-active first with preview + counts", () => {
  writeJsonl(
    "old",
    [userMsg("first conversation", "2026-01-01T00:00:00.000Z"), asstMsg("ok", "2026-01-01T00:01:00.000Z")],
    Date.parse("2026-01-01T00:01:00.000Z"),
  );
  writeJsonl(
    "new",
    [
      userMsg("fix the watcher bug", "2026-02-01T00:00:00.000Z"),
      asstMsg("on it", "2026-02-01T00:01:00.000Z"),
      userMsg("thanks", "2026-02-01T00:02:00.000Z"),
    ],
    Date.parse("2026-02-01T00:02:00.000Z"),
  );

  const res = listConversations({ cwd: personaCwd, claudeProjectsRoot: projectsRoot });
  expect(res.total).toBe(2);
  expect(res.truncated).toBe(false);
  expect(res.conversations.map((c) => c.session_id)).toEqual(["new", "old"]);

  const newest = res.conversations[0]!;
  expect(newest.last_user_message).toEqual({
    text: "thanks",
    at: "2026-02-01T00:02:00.000Z",
  });
  expect(newest.last_agent_message).toEqual({
    text: "on it",
    at: "2026-02-01T00:01:00.000Z",
  });
  expect(newest.last_speaker).toBe("user");
  expect(newest.turn_count).toBe(3);
  expect(newest.user_turn_count).toBe(2);
  expect(newest.started_at).toBe("2026-02-01T00:00:00.000Z");
  expect(newest.last_active_at).toBe("2026-02-01T00:02:00.000Z");
});

test("last_speaker reflects the final turn; both tails captured", () => {
  writeJsonl("s", [
    userMsg("hi", "2026-01-01T00:00:00.000Z"),
    asstMsg("hello", "2026-01-01T00:01:00.000Z"),
    userMsg("do X", "2026-01-01T00:02:00.000Z"),
    asstMsg("done", "2026-01-01T00:03:00.000Z"),
  ]);
  const c = listConversations({
    cwd: personaCwd,
    claudeProjectsRoot: projectsRoot,
  }).conversations[0]!;
  expect(c.last_speaker).toBe("agent");
  expect(c.last_user_message!.text).toBe("do X");
  expect(c.last_agent_message!.text).toBe("done");
});

test("is_current_session flags the calling session", () => {
  writeJsonl("a", [userMsg("hi")]);
  writeJsonl("b", [userMsg("yo")]);
  const res = listConversations({
    cwd: personaCwd,
    claudeProjectsRoot: projectsRoot,
    currentSessionId: "a",
  });
  const a = res.conversations.find((c) => c.session_id === "a")!;
  const b = res.conversations.find((c) => c.session_id === "b")!;
  expect(a.is_current_session).toBe(true);
  expect(b.is_current_session).toBe(false);
});

test("limit caps results and reports truncated", () => {
  writeJsonl("c1", [userMsg("one")], 1000);
  writeJsonl("c2", [userMsg("two")], 2000);
  writeJsonl("c3", [userMsg("three")], 3000);
  const res = listConversations({
    cwd: personaCwd,
    claudeProjectsRoot: projectsRoot,
    limit: 2,
  });
  expect(res.conversations).toHaveLength(2);
  expect(res.total).toBe(3);
  expect(res.truncated).toBe(true);
  expect(res.conversations.map((c) => c.session_id)).toEqual(["c3", "c2"]);
});

test("since filters by last-active mtime", () => {
  writeJsonl("stale", [userMsg("old")], Date.parse("2026-01-01T00:00:00.000Z"));
  writeJsonl("fresh", [userMsg("new")], Date.parse("2026-03-01T00:00:00.000Z"));
  const res = listConversations({
    cwd: personaCwd,
    claudeProjectsRoot: projectsRoot,
    since: "2026-02-01T00:00:00.000Z",
  });
  expect(res.conversations.map((c) => c.session_id)).toEqual(["fresh"]);
  expect(res.total).toBe(1);
});

test("message text caps at CONVERSATION_PREVIEW_MAX_CHARS and normalizes whitespace", () => {
  const long = "word ".repeat(200);
  writeJsonl("long", [userMsg(long)]);
  const res = listConversations({ cwd: personaCwd, claudeProjectsRoot: projectsRoot });
  const c = res.conversations[0]!;
  expect(c.last_user_message!.text.length).toBe(CONVERSATION_PREVIEW_MAX_CHARS);
  expect(c.last_user_message!.text).not.toContain("  ");
});

test("agent-only conversation has null last_user_message", () => {
  writeJsonl("agent-only", [asstMsg("automated kickoff")]);
  const res = listConversations({ cwd: personaCwd, claudeProjectsRoot: projectsRoot });
  const c = res.conversations[0]!;
  expect(c.last_user_message).toBeNull();
  expect(c.last_agent_message!.text).toBe("automated kickoff");
  expect(c.last_speaker).toBe("agent");
  expect(c.user_turn_count).toBe(0);
});

test("multi stamps persona_username and merges newest-first across personas", () => {
  // alpha persona (default sessionDir)
  writeJsonl("alpha-1", [userMsg("alpha topic")], Date.parse("2026-01-01T00:00:00.000Z"));

  // beta persona in a different cwd
  const betaCwd = "/work/beta";
  const betaDir = path.join(projectsRoot, encodeCwdForClaudeProject(betaCwd));
  fs.mkdirSync(betaDir, { recursive: true });
  const betaFile = path.join(betaDir, "beta-1.jsonl");
  fs.writeFileSync(betaFile, JSON.stringify(userMsg("beta topic")) + "\n");
  fs.utimesSync(betaFile, Date.parse("2026-05-01T00:00:00.000Z") / 1000, Date.parse("2026-05-01T00:00:00.000Z") / 1000);

  const res = listConversationsMulti(
    [
      { username: "alpha", cwd: personaCwd },
      { username: "beta", cwd: betaCwd },
    ],
    { claudeProjectsRoot: projectsRoot },
  );
  expect(res.total).toBe(2);
  expect(res.conversations.map((c) => c.persona_username)).toEqual(["beta", "alpha"]);
});

test("default limit constant is exported and applied", () => {
  for (let i = 0; i < DEFAULT_LIST_CONVERSATIONS_LIMIT + 5; i++) {
    writeJsonl(`s${i}`, [userMsg(`msg ${i}`)], 1000 + i * 1000);
  }
  const res = listConversations({ cwd: personaCwd, claudeProjectsRoot: projectsRoot });
  expect(res.conversations).toHaveLength(DEFAULT_LIST_CONVERSATIONS_LIMIT);
  expect(res.truncated).toBe(true);
});
