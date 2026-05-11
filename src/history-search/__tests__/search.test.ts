import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_FETCH_MAX_CHARS,
  fetchHistoryMessage,
  searchHistory,
  searchHistoryMulti,
  encodeCwdForClaudeProject,
  type PersonaTarget,
} from "../index.ts";

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

test("searchHistoryMulti: walks every persona, stamps persona_username on hits", () => {
  // Persona A.
  const cwdA = "/work/alpha";
  const dirA = path.join(projectsRoot, encodeCwdForClaudeProject(cwdA));
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(
    path.join(dirA, "sA.jsonl"),
    JSON.stringify({ type: "user", message: { content: "alpha said badger" } }) +
      "\n",
  );
  // Persona B.
  const cwdB = "/work/beta";
  const dirB = path.join(projectsRoot, encodeCwdForClaudeProject(cwdB));
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(
    path.join(dirB, "sB.jsonl"),
    JSON.stringify({ type: "user", message: { content: "beta said badger" } }) +
      "\n",
  );

  const personas: PersonaTarget[] = [
    { username: "alpha", cwd: cwdA },
    { username: "beta", cwd: cwdB },
  ];
  const hits = searchHistoryMulti(personas, {
    query: "badger",
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(2);
  const byUser = Object.fromEntries(hits.map((h) => [h.persona_username, h]));
  expect(byUser["alpha"]).toBeTruthy();
  expect(byUser["beta"]).toBeTruthy();
  expect(byUser["alpha"]!.session_id).toBe("sA");
  expect(byUser["beta"]!.session_id).toBe("sB");
});

test("searchHistoryMulti: limit caps the global hit count, not per-persona", () => {
  const cwdA = "/work/alpha";
  const dirA = path.join(projectsRoot, encodeCwdForClaudeProject(cwdA));
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(
    path.join(dirA, "sA.jsonl"),
    [
      JSON.stringify({ type: "user", message: { content: "match 1" } }),
      JSON.stringify({ type: "user", message: { content: "match 2" } }),
    ].join("\n"),
  );
  const cwdB = "/work/beta";
  const dirB = path.join(projectsRoot, encodeCwdForClaudeProject(cwdB));
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(
    path.join(dirB, "sB.jsonl"),
    [
      JSON.stringify({ type: "user", message: { content: "match 3" } }),
      JSON.stringify({ type: "user", message: { content: "match 4" } }),
    ].join("\n"),
  );

  const personas: PersonaTarget[] = [
    { username: "alpha", cwd: cwdA },
    { username: "beta", cwd: cwdB },
  ];
  const hits = searchHistoryMulti(personas, {
    query: "match",
    limit: 3,
    claudeProjectsRoot: projectsRoot,
  });
  expect(hits).toHaveLength(3);
});

test("searchHistoryMulti: stamps current_session flag only for the calling persona's session", () => {
  const cwdA = "/work/alpha";
  const dirA = path.join(projectsRoot, encodeCwdForClaudeProject(cwdA));
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(
    path.join(dirA, "s-current.jsonl"),
    JSON.stringify({ type: "user", message: { content: "find me" } }) + "\n",
  );
  const cwdB = "/work/beta";
  const dirB = path.join(projectsRoot, encodeCwdForClaudeProject(cwdB));
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(
    path.join(dirB, "s-current.jsonl"),
    JSON.stringify({ type: "user", message: { content: "find me too" } }) +
      "\n",
  );

  const personas: PersonaTarget[] = [
    { username: "alpha", cwd: cwdA },
    { username: "beta", cwd: cwdB },
  ];
  const hits = searchHistoryMulti(personas, {
    query: "find me",
    claudeProjectsRoot: projectsRoot,
    // currentSessionId is the calling session — even though both
    // personas happen to have a session with the same UUID-style name
    // (impossible in practice, here just for the test), only one is
    // actually the current one. The current_session check is by id
    // only, so both will flag — but the test just exercises that the
    // flag survives the multi wrapper.
    currentSessionId: "s-current",
  });
  expect(hits.every((h) => h.is_current_session)).toBe(true);
});

test("fetchHistoryMessage: returns full content for matched (session_id, message_at)", () => {
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: "first record" },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "second record full body" }] },
      timestamp: "2026-05-10T10:01:00.000Z",
    },
  ]);
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:01:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched).not.toBeNull();
  expect(fetched!.role).toBe("assistant");
  expect(fetched!.content).toBe("second record full body");
  expect(fetched!.size_chars).toBe("second record full body".length);
  expect(fetched!.truncated).toBe(false);
  expect(fetched!.session_id).toBe("s-1");
  expect(fetched!.message_at).toBe("2026-05-10T10:01:00.000Z");
});

test("fetchHistoryMessage: missing session file returns null", () => {
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "does-not-exist",
    message_at: "2026-05-10T10:00:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched).toBeNull();
});

test("fetchHistoryMessage: session exists but no matching timestamp returns null", () => {
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: "only one" },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
  ]);
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T11:00:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched).toBeNull();
});

test("fetchHistoryMessage: max_chars truncates content and flags truncated:true", () => {
  const big = "x".repeat(500);
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: big },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
  ]);
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:00:00.000Z",
    maxChars: 100,
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched).not.toBeNull();
  expect(fetched!.content.length).toBe(100);
  expect(fetched!.size_chars).toBe(500);
  expect(fetched!.truncated).toBe(true);
});

test("fetchHistoryMessage: content at exactly max_chars is NOT truncated", () => {
  const exact = "y".repeat(100);
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: exact },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
  ]);
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:00:00.000Z",
    maxChars: 100,
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched).not.toBeNull();
  expect(fetched!.content.length).toBe(100);
  expect(fetched!.size_chars).toBe(100);
  expect(fetched!.truncated).toBe(false);
});

test("fetchHistoryMessage: default max_chars is DEFAULT_FETCH_MAX_CHARS", () => {
  expect(DEFAULT_FETCH_MAX_CHARS).toBe(256_000);
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: "small body" },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
  ]);
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:00:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched!.truncated).toBe(false);
  expect(fetched!.content).toBe("small body");
});

test("fetchHistoryMessage: multi-block content uses stringifyContent projection", () => {
  writeJsonl("s-1", [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "line one" },
          { type: "tool_use", name: "Read", input: { file: "/tmp/x" } },
          { type: "text", text: "line three" },
        ],
      },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
  ]);
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:00:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched).not.toBeNull();
  expect(fetched!.content).toContain("line one");
  expect(fetched!.content).toContain('[tool_use Read: {"file":"/tmp/x"}]');
  expect(fetched!.content).toContain("line three");
});

test("fetchHistoryMessage: first record wins on duplicate timestamp", () => {
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: "first one" },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
    {
      type: "user",
      message: { content: "second one" },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
  ]);
  const fetched = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:00:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(fetched!.content).toBe("first one");
});

test("fetchHistoryMessage: record with empty extractable content is skipped", () => {
  // Type 'user' with empty content array → extractText returns null.
  writeJsonl("s-1", [
    {
      type: "user",
      message: { content: [] },
      timestamp: "2026-05-10T10:00:00.000Z",
    },
    {
      type: "user",
      message: { content: "real content" },
      timestamp: "2026-05-10T10:01:00.000Z",
    },
  ]);
  // Asking for the empty timestamp → null (skipped).
  const empty = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:00:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(empty).toBeNull();
  // Asking for the real one → returned even though the empty one
  // appeared first in the file.
  const real = fetchHistoryMessage({
    cwd: personaCwd,
    session_id: "s-1",
    message_at: "2026-05-10T10:01:00.000Z",
    claudeProjectsRoot: projectsRoot,
  });
  expect(real!.content).toBe("real content");
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
