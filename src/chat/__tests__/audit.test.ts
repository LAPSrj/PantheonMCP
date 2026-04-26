import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { ChatRouter, appendAudit, auditPath, isAuditEnabled } from "../index.ts";
import type { Message } from "../types.ts";

let tmpDir: string;
let paths: Paths;
let prevEnv: string | undefined;
let prevPath: string | undefined;
let auditFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-audit-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  prevEnv = process.env.PANTHEON_CHAT_AUDIT_LOG;
  prevPath = process.env.PANTHEON_CHAT_AUDIT_PATH;
  auditFile = path.join(tmpDir, "chat-audit.jsonl");
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PANTHEON_CHAT_AUDIT_LOG;
  else process.env.PANTHEON_CHAT_AUDIT_LOG = prevEnv;
  if (prevPath === undefined) delete process.env.PANTHEON_CHAT_AUDIT_PATH;
  else process.env.PANTHEON_CHAT_AUDIT_PATH = prevPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureMsg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    seq: 1,
    ts: 1_700_000_000_000,
    from_agent_id: "alpha",
    from_project: "ops",
    scope: "global",
    text: "hello",
    mentions: [],
    from_username_inline: null,
    ...over,
  } as Message;
}

test("isAuditEnabled honors `1`, `true`, `yes` (case-insensitive); off by default", () => {
  expect(isAuditEnabled()).toBe(false);
  for (const v of ["1", "true", "TRUE", "yes", "YES"]) {
    process.env.PANTHEON_CHAT_AUDIT_LOG = v;
    expect(isAuditEnabled()).toBe(true);
  }
  process.env.PANTHEON_CHAT_AUDIT_LOG = "0";
  expect(isAuditEnabled()).toBe(false);
});

test("appendAudit is a no-op when env var is unset", () => {
  appendAudit(paths, fixtureMsg());
  expect(fs.existsSync(auditFile)).toBe(false);
});

test("appendAudit writes one JSONL line per message when enabled", () => {
  process.env.PANTHEON_CHAT_AUDIT_LOG = "1";
  process.env.PANTHEON_CHAT_AUDIT_PATH = auditFile;
  appendAudit(paths, fixtureMsg());
  appendAudit(
    paths,
    fixtureMsg({
      id: "m2",
      seq: 2,
      scope: "dm",
      target: "betauser",
      text: "private",
    }),
  );
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(first.id).toBe("m1");
  expect(first.scope).toBe("global");
  expect(first.text).toBe("hello");
  expect(first.target).toBeUndefined();
  const second = JSON.parse(lines[1]!) as Record<string, unknown>;
  expect(second.scope).toBe("dm");
  expect(second.target).toBe("betauser");
});

test("auditPath honors PANTHEON_CHAT_AUDIT_PATH override", () => {
  expect(auditPath(paths)).toBe(path.join(paths.stateDir, "chat-audit.jsonl"));
  process.env.PANTHEON_CHAT_AUDIT_PATH = "/tmp/custom-audit.jsonl";
  expect(auditPath(paths)).toBe("/tmp/custom-audit.jsonl");
});

test("ChatRouter.addMessage triggers audit append when enabled", () => {
  process.env.PANTHEON_CHAT_AUDIT_LOG = "1";
  process.env.PANTHEON_CHAT_AUDIT_PATH = auditFile;
  const router = new ChatRouter({ paths });
  const sub = router.add({ username: "alpha", project: "ops", transient: false });
  router.addMessage({
    from_agent_id: sub.agent_id,
    scope: "global",
    text: "hello world",
  });
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(1);
  // The user-sent message should be among the audited rows.
  const found = lines
    .map((l) => JSON.parse(l) as { text: string })
    .some((row) => row.text === "hello world");
  expect(found).toBe(true);
});

test("appendAudit silently no-ops on write failure (best-effort)", () => {
  process.env.PANTHEON_CHAT_AUDIT_LOG = "1";
  // Point at a path inside a read-only directory we know we can't write.
  // Easiest: make the parent path point to an existing FILE so the
  // directory create + append both fail.
  const blocker = path.join(tmpDir, "blocker");
  fs.writeFileSync(blocker, "x");
  process.env.PANTHEON_CHAT_AUDIT_PATH = path.join(blocker, "audit.jsonl");
  // Should not throw.
  expect(() => appendAudit(paths, fixtureMsg())).not.toThrow();
});
