import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
import { runConsole } from "../console.ts";

let tmpDir: string;
let paths: Paths;

class StringSink extends Writable {
  buf = "";
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-console-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("--help prints usage and exits 0", async () => {
  const code = await runConsole({
    args: ["--help"],
    stdin: Readable.from([]),
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
  });
  expect(code).toBe(0);
});

test("unknown flag exits 1 with stderr message", async () => {
  const stderr = new StringSink();
  const code = await runConsole({
    args: ["--bogus"],
    stdin: Readable.from([]),
    stdout: new StringSink(),
    stderr,
    paths,
  });
  expect(code).toBe(1);
  expect(stderr.buf).toContain("unknown argument '--bogus'");
});

test("--tail with bad value exits 1", async () => {
  const stderr = new StringSink();
  const code = await runConsole({
    args: ["--tail", "abc"],
    stdin: Readable.from([]),
    stdout: new StringSink(),
    stderr,
    paths,
  });
  expect(code).toBe(1);
  expect(stderr.buf).toContain("--tail expects a non-negative integer");
});

test("non-TTY stdin: a bare line broadcasts to scope=global as admin", async () => {
  const code = await runConsole({
    args: ["--no-tail", "--no-color", "--no-roster"],
    stdin: Readable.from(["hello world\n"]),
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
  });
  expect(code).toBe(0);
  // Verify the message landed in chat.db with the admin shape.
  const db = openChatDb(paths.chatDbPath);
  try {
    const rows = db
      .query("SELECT * FROM messages WHERE scope = ? ORDER BY seq DESC LIMIT 1")
      .all("global") as Array<{
        text: string;
        from_agent_id: string;
        from_username_inline: string | null;
        kind: string | null;
      }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("[ADMIN] hello world");
    expect(rows[0]!.from_agent_id).toBe("system");
    expect(rows[0]!.from_username_inline).toBe("admin");
  } finally {
    db.close();
  }
});

test("non-TTY stdin: /dm sends a scoped DM to the named target", async () => {
  await runConsole({
    args: ["--no-tail", "--no-color", "--no-roster"],
    stdin: Readable.from(["/dm vellumpike check the build\n"]),
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
  });
  const db = openChatDb(paths.chatDbPath);
  try {
    const row = db
      .query("SELECT * FROM messages WHERE scope = ? ORDER BY seq DESC LIMIT 1")
      .get("dm") as { text: string; target_username: string | null };
    expect(row).not.toBeNull();
    expect(row.text).toBe("[ADMIN] check the build");
    expect(row.target_username).toBe("vellumpike");
  } finally {
    db.close();
  }
});

test("non-TTY stdin: /proj sends to the named project", async () => {
  await runConsole({
    args: ["--no-tail", "--no-color", "--no-roster"],
    stdin: Readable.from(["/proj nyus pause work\n"]),
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
  });
  const db = openChatDb(paths.chatDbPath);
  try {
    const row = db
      .query("SELECT * FROM messages WHERE scope = ? ORDER BY seq DESC LIMIT 1")
      .get("project") as { text: string; project: string | null };
    expect(row.text).toBe("[ADMIN] pause work");
    expect(row.project).toBe("nyus");
  } finally {
    db.close();
  }
});

test("non-TTY stdin: /quit ends the session cleanly", async () => {
  // /quit on its own — the rl 'line' handler returns false → close.
  const code = await runConsole({
    args: ["--no-tail", "--no-roster"],
    stdin: Readable.from(["/quit\n"]),
    stdout: new StringSink(),
    stderr: new StringSink(),
    paths,
  });
  expect(code).toBe(0);
});

test("non-TTY stdin: /dm with missing text emits a usage hint, no message persisted", async () => {
  const stderr = new StringSink();
  await runConsole({
    args: ["--no-tail", "--no-roster"],
    stdin: Readable.from(["/dm vellumpike\n"]),
    stdout: new StringSink(),
    stderr,
    paths,
  });
  expect(stderr.buf).toContain("Usage: /dm <user> <text>");
  const db = openChatDb(paths.chatDbPath);
  try {
    const rows = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
    expect(rows.n).toBe(0);
  } finally {
    db.close();
  }
});

test("non-TTY stdin: unknown slash command writes to stderr but doesn't exit", async () => {
  const stderr = new StringSink();
  await runConsole({
    args: ["--no-tail", "--no-roster"],
    stdin: Readable.from(["/bogus\nhello\n"]),
    stdout: new StringSink(),
    stderr,
    paths,
  });
  expect(stderr.buf).toContain("unknown command '/bogus'");
  // The subsequent line still broadcasts.
  const db = openChatDb(paths.chatDbPath);
  try {
    const row = db
      .query("SELECT text FROM messages ORDER BY seq DESC LIMIT 1")
      .get() as { text: string } | undefined;
    expect(row?.text).toBe("[ADMIN] hello");
  } finally {
    db.close();
  }
});
