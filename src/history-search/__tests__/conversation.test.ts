import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_CONTEXT_TURNS,
  extractConversation,
  encodeCwdForClaudeProject,
} from "../index.ts";

let tmpDir: string;
let projectsRoot: string;
let sessionDir: string;
let personaCwd: string;

function writeJsonl(name: string, records: unknown[]): string {
  const filePath = path.join(sessionDir, `${name}.jsonl`);
  fs.writeFileSync(
    filePath,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return filePath;
}

// Convenience record builders matching CC JSONL shapes.
const userMsg = (content: unknown, timestamp?: string) => ({
  type: "user",
  message: { content },
  ...(timestamp ? { timestamp } : {}),
});
const asstMsg = (text: string, timestamp?: string, extra?: object) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
  ...(timestamp ? { timestamp } : {}),
  ...(extra ?? {}),
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-convo-"));
  projectsRoot = path.join(tmpDir, ".claude", "projects");
  personaCwd = "/work/alpha";
  sessionDir = path.join(projectsRoot, encodeCwdForClaudeProject(personaCwd));
  fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("missing session file returns null", () => {
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "does-not-exist",
    claudeProjectsRoot: projectsRoot,
  });
  expect(result).toBeNull();
});

test("extracts user/agent turns and groups consecutive same-party", () => {
  writeJsonl("s-1", [
    userMsg("hello there"),
    asstMsg("hi"),
    asstMsg("how can I help?"),
    userMsg("fix the bug"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result).not.toBeNull();
  expect(result.turns).toEqual([
    { role: "user", content: ["hello there"] },
    { role: "agent", content: ["hi", "how can I help?"] },
    { role: "user", content: ["fix the bug"] },
  ]);
  expect(result.total_turns).toBe(3);
  expect(result.role_counts).toEqual({ user: 2, agent: 1, subagent: 0 });
  expect(result.truncated).toBe(false);
  expect(result.next_cursor).toBeNull();
});

test("sidechain assistant rows are tagged subagent; sidechain user dropped", () => {
  writeJsonl("s-1", [
    userMsg("main turn"),
    { ...asstMsg("subagent speaking"), isSidechain: true },
    { ...userMsg("subagent prompt plumbing"), isSidechain: true },
    asstMsg("main agent reply"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["main turn"] },
    { role: "subagent", content: ["subagent speaking"] },
    { role: "agent", content: ["main agent reply"] },
  ]);
});

test("drops tool_use / tool_result / thinking; keeps text blocks", () => {
  writeJsonl("s-1", [
    userMsg([
      { type: "text", text: "do a thing" },
      { type: "tool_result", content: "noise" },
    ]),
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "done" },
          { type: "tool_use", name: "Read", input: { file: "/tmp/x" } },
        ],
      },
    },
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["do a thing"] },
    { role: "agent", content: ["done"] },
  ]);
});

test("strips system-reminder / command plumbing and surfaces slash command", () => {
  writeJsonl("s-1", [
    userMsg(
      "<system-reminder>boot junk</system-reminder>real question here",
    ),
    userMsg(
      "<command-message>foo</command-message><command-name>/deploy</command-name><command-args>prod</command-args>",
    ),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["real question here", "/deploy prod"] },
  ]);
});

test("drops task-notification and summon bootstrap user injections", () => {
  writeJsonl("s-1", [
    userMsg("You are being summoned via pantheon. ## boot manifest ..."),
    userMsg("<task-notification>monitor tick</task-notification>"),
    userMsg("the real first turn"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["the real first turn"] },
  ]);
});

test("drops interrupt markers and `.`-only agent filler", () => {
  writeJsonl("s-1", [
    userMsg("question"),
    asstMsg("."),
    userMsg("[Request interrupted by user]"),
    asstMsg("real answer"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["question"] },
    { role: "agent", content: ["real answer"] },
  ]);
});

test("recovers a mid-turn queued human message never re-logged as a user turn", () => {
  writeJsonl("s-1", [
    userMsg("start the task"),
    asstMsg("working on it"),
    {
      type: "queue-operation",
      operation: "enqueue",
      content: "actually this is dom_query reinvented",
    },
    asstMsg("you're right, switching approach"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["start the task"] },
    { role: "agent", content: ["working on it"] },
    { role: "user", content: ["actually this is dom_query reinvented"] },
    { role: "agent", content: ["you're right, switching approach"] },
  ]);
});

test("does NOT double-emit a queued message already materialized as a real turn", () => {
  writeJsonl("s-1", [
    {
      type: "queue-operation",
      operation: "enqueue",
      content: "delayed question",
    },
    userMsg("delayed question"),
    asstMsg("answer"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["delayed question"] },
    { role: "agent", content: ["answer"] },
  ]);
});

test("does NOT recover harness sentinels from the queue", () => {
  writeJsonl("s-1", [
    {
      type: "queue-operation",
      operation: "enqueue",
      content: "<<autonomous-loop-dynamic>>",
    },
    userMsg("genuine turn"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([{ role: "user", content: ["genuine turn"] }]);
});

test("malformed JSONL lines are skipped, not fatal", () => {
  const filePath = path.join(sessionDir, "s-corrupt.jsonl");
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify(userMsg("valid one")),
      "this is not json",
      JSON.stringify(asstMsg("valid two")),
    ].join("\n"),
  );
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-corrupt",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([
    { role: "user", content: ["valid one"] },
    { role: "agent", content: ["valid two"] },
  ]);
});

// ---- budget + cursor pagination ----

test("max_chars budget returns whole turns until overflow and sets next_cursor", () => {
  writeJsonl("s-1", [
    userMsg("aaaa"), // 4 chars, turn 0
    asstMsg("bbbb"), // 4 chars, turn 1
    userMsg("cccc"), // 4 chars, turn 2
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    maxChars: 9,
    claudeProjectsRoot: projectsRoot,
  })!;
  // 4 + 4 = 8 <= 9; adding the third (12) would overflow.
  expect(result.turns).toEqual([
    { role: "user", content: ["aaaa"] },
    { role: "agent", content: ["bbbb"] },
  ]);
  expect(result.returned_turns).toBe(2);
  expect(result.total_turns).toBe(3);
  expect(result.truncated).toBe(true);
  expect(result.next_cursor).toBe(2);
});

test("cursor resumes from a prior next_cursor and reports earlier turns omitted", () => {
  writeJsonl("s-1", [userMsg("aaaa"), asstMsg("bbbb"), userMsg("cccc")]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    cursor: 2,
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.turns).toEqual([{ role: "user", content: ["cccc"] }]);
  expect(result.truncated).toBe(true); // earlier turns were skipped
  expect(result.next_cursor).toBeNull(); // nothing after
});

test("a single oversized turn is always returned (progress guaranteed)", () => {
  writeJsonl("s-1", [userMsg("x".repeat(100)), asstMsg("y".repeat(100))]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    maxChars: 10,
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.returned_turns).toBe(1);
  expect(result.turns[0]!.content[0]!.length).toBe(100);
  expect(result.next_cursor).toBe(1);
});

// ---- windowed (around) mode ----

test("around returns a window centered on the anchor turn", () => {
  writeJsonl("s-1", [
    userMsg("t0", "2026-05-10T10:00:00.000Z"),
    asstMsg("t1", "2026-05-10T10:01:00.000Z"),
    userMsg("t2", "2026-05-10T10:02:00.000Z"),
    asstMsg("t3", "2026-05-10T10:03:00.000Z"),
    userMsg("t4", "2026-05-10T10:04:00.000Z"),
  ]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    around: "2026-05-10T10:02:00.000Z",
    contextTurns: 1,
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.anchor_turn_index).toBe(2);
  expect(result.turns).toEqual([
    { role: "agent", content: ["t1"] },
    { role: "user", content: ["t2"] },
    { role: "agent", content: ["t3"] },
  ]);
  expect(result.truncated).toBe(true); // t0 and t4 omitted
  expect(result.next_cursor).toBe(4);
});

test("around with unmatched timestamp yields null anchor and empty turns", () => {
  writeJsonl("s-1", [userMsg("t0", "2026-05-10T10:00:00.000Z")]);
  const result = extractConversation({
    cwd: personaCwd,
    session_id: "s-1",
    around: "2099-01-01T00:00:00.000Z",
    claudeProjectsRoot: projectsRoot,
  })!;
  expect(result.anchor_turn_index).toBeNull();
  expect(result.turns).toEqual([]);
});

test("default context_turns is 3", () => {
  expect(DEFAULT_CONTEXT_TURNS).toBe(3);
});
