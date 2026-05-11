import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { searchHistory, encodeCwdForClaudeProject } from "../index.ts";

let tmpDir: string;
let projectsRoot: string;
let sessionDir: string;
let personaCwd: string;

function writeJsonl(name: string, records: unknown[]): string {
  const filePath = path.join(sessionDir, `${name}.jsonl`);
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-history-"));
  projectsRoot = path.join(tmpDir, ".claude", "projects");
  personaCwd = "/work/alpha";
  sessionDir = path.join(projectsRoot, encodeCwdForClaudeProject(personaCwd));
  fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("encodeCwdForClaudeProject replaces / with -", () => {
  expect(encodeCwdForClaudeProject("/home/leandro/repos/pantheon")).toBe(
    "-home-leandro-repos-pantheon",
  );
});

test("substring match across multiple sessions; current_session flag set", () => {
  writeJsonl("s-old", [
    {
      type: "user",
      message: { content: "Let's debug the migration glitch" },
      timestamp: "2026-05-01T10:00:00.000Z",
    },
  ]);
  writeJsonl("s-current", [
    {
      type: "user",
      message: { content: "Pizza is on the migration menu" },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "migration",
    claudeProjectsRoot: projectsRoot,
    currentSessionId: "s-current",
  });
  expect(hits).toHaveLength(2);
  const current = hits.find((h) => h.session_id === "s-current")!;
  expect(current.is_current_session).toBe(true);
  const old = hits.find((h) => h.session_id === "s-old")!;
  expect(old.is_current_session).toBe(false);
});

test("scope='current' returns only this session's matches", () => {
  writeJsonl("s-old", [
    { type: "user", message: { content: "old chatter about kittens" } },
  ]);
  writeJsonl("s-current", [
    { type: "user", message: { content: "current chatter about kittens" } },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "kittens",
    scope: "current",
    claudeProjectsRoot: projectsRoot,
    currentSessionId: "s-current",
  });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.session_id).toBe("s-current");
});

test("scope='previous' returns everything BUT this session", () => {
  writeJsonl("s-old1", [{ type: "user", message: { content: "alpha goldfish" } }]);
  writeJsonl("s-old2", [{ type: "user", message: { content: "beta goldfish" } }]);
  writeJsonl("s-current", [
    { type: "user", message: { content: "current goldfish" } },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "goldfish",
    scope: "previous",
    claudeProjectsRoot: projectsRoot,
    currentSessionId: "s-current",
  });
  const ids = hits.map((h) => h.session_id).sort();
  expect(ids).toEqual(["s-old1", "s-old2"]);
});

test("regex mode matches a JS regex pattern; throws on bad regex", () => {
  writeJsonl("s-1", [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "PR #4242 landed cleanly" },
        ],
      },
    },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "PR #\\d{4}",
    regex: true,
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.context).toContain("[PR #4242]");

  expect(() =>
    searchHistory({
      cwd: personaCwd,
      query: "(unclosed-group",
      regex: true,
      claudeProjectsRoot: projectsRoot,
    }),
  ).toThrow(/Invalid regex/);
});

test("role filter narrows to user-only or assistant-only", () => {
  writeJsonl("s-1", [
    { type: "user", message: { content: "panic the badger" } },
    { type: "assistant", message: { content: [{ type: "text", text: "calm the badger" }] } },
  ]);
  const userHits = searchHistory({
    cwd: personaCwd,
    query: "badger",
    role: "user",
    claudeProjectsRoot: projectsRoot,
  });
  expect(userHits).toHaveLength(1);
  expect(userHits[0]!.role).toBe("user");

  const asstHits = searchHistory({
    cwd: personaCwd,
    query: "badger",
    role: "assistant",
    claudeProjectsRoot: projectsRoot,
  });
  expect(asstHits).toHaveLength(1);
  expect(asstHits[0]!.role).toBe("assistant");
});

test("limit caps the number of hits", () => {
  writeJsonl("s-1", [
    { type: "user", message: { content: "needle 1" } },
    { type: "user", message: { content: "needle 2" } },
    { type: "user", message: { content: "needle 3" } },
    { type: "user", message: { content: "needle 4" } },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "needle",
    limit: 2,
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(2);
});

test("case_insensitive=true is the default", () => {
  writeJsonl("s-1", [
    { type: "user", message: { content: "TYPE casing matters?" } },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "type",
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(1);
});

test("case_insensitive=false respects exact case", () => {
  writeJsonl("s-1", [
    { type: "user", message: { content: "TYPE casing matters?" } },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "type",
    case_insensitive: false,
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(0);
});

test("malformed JSONL lines are skipped, not fatal", () => {
  const filePath = path.join(sessionDir, "s-corrupt.jsonl");
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "user", message: { content: "valid one" } }),
      "this is not json",
      JSON.stringify({ type: "user", message: { content: "valid two" } }),
    ].join("\n"),
  );
  const hits = searchHistory({
    cwd: personaCwd,
    query: "valid",
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(2);
});

test("missing project dir returns empty (not throw)", () => {
  const hits = searchHistory({
    cwd: "/totally/different/cwd",
    query: "anything",
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toEqual([]);
});

test("since filter excludes older messages", () => {
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: "old badger" },
      timestamp: "2026-01-01T10:00:00.000Z",
    },
    {
      type: "user",
      message: { content: "fresh badger" },
      timestamp: "2026-05-01T10:00:00.000Z",
    },
  ]);
  const hits = searchHistory({
    cwd: personaCwd,
    query: "badger",
    since: "2026-04-01",
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.snippet).toContain("fresh");
});
