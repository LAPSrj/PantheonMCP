import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
import { ChatRouter } from "../../chat/index.ts";
import { runConsole } from "../console.ts";

/** Helper: register a live presence row so console-CLI offline checks
 * see the username/project as connected. The console refuses /dm and
 * /proj when the target isn't online (recipient_offline parity with
 * the MCP send_message / send_structured / ask handlers). */
function seedSubscriber(
  paths: Paths,
  username: string,
  project: string,
): void {
  const db = openChatDb(paths.chatDbPath);
  try {
    const router = new ChatRouter({ paths, db });
    router.add({ username, project, transient: false });
  } finally {
    db.close();
  }
}

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
    expect(rows[0]!.text).toBe("hello world");
    expect(rows[0]!.from_agent_id).toBe("system");
    expect(rows[0]!.from_username_inline).toBe("admin");
  } finally {
    db.close();
  }
});

test("non-TTY stdin: /dm sends a scoped DM to the named target", async () => {
  // Recipient must be online for the DM to go through (recipient_offline
  // parity with MCP send_message). Seed a live presence row first.
  seedSubscriber(paths, "vellumpike", "pantheon");
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
    expect(row.text).toBe("check the build");
    expect(row.target_username).toBe("vellumpike");
  } finally {
    db.close();
  }
});

test("non-TTY stdin: /dm to an OFFLINE target refuses with recipient_offline; nothing persisted", async () => {
  // No seed — the named user has never logged in, so they're offline.
  const stdout = new StringSink();
  await runConsole({
    args: ["--no-tail", "--no-color", "--no-roster"],
    stdin: Readable.from(["/dm ghost-user hello?\n"]),
    stdout,
    stderr: new StringSink(),
    paths,
  });
  expect(stdout.buf).toContain("recipient_offline");
  expect(stdout.buf).toContain("ghost-user");
  // No row landed in chat.db — refuse means refuse, no phantom queue.
  const db = openChatDb(paths.chatDbPath);
  try {
    const rows = db
      .query("SELECT COUNT(*) AS n FROM messages WHERE scope = 'dm'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  } finally {
    db.close();
  }
});

test("non-TTY stdin: /proj sends to the named project", async () => {
  // At least one agent must be in the project for the broadcast to go.
  seedSubscriber(paths, "vellumpike", "nyus");
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
    expect(row.text).toBe("pause work");
    expect(row.project).toBe("nyus");
  } finally {
    db.close();
  }
});

test("non-TTY stdin: /proj to a project with ZERO agents refuses; nothing persisted", async () => {
  const stdout = new StringSink();
  await runConsole({
    args: ["--no-tail", "--no-color", "--no-roster"],
    stdin: Readable.from(["/proj abandoned no one home\n"]),
    stdout,
    stderr: new StringSink(),
    paths,
  });
  expect(stdout.buf).toContain("recipient_offline");
  expect(stdout.buf).toContain("'abandoned'");
  const db = openChatDb(paths.chatDbPath);
  try {
    const rows = db
      .query("SELECT COUNT(*) AS n FROM messages WHERE scope = 'project'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
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
  const stdout = new StringSink();
  await runConsole({
    args: ["--no-tail", "--no-roster"],
    stdin: Readable.from(["/dm vellumpike\n"]),
    stdout,
    stderr: new StringSink(),
    paths,
  });
  // Slash-command errors render inline (red), not on stderr — chat-mcp parity.
  expect(stdout.buf).toContain("usage: /dm <user> <text>");
  const db = openChatDb(paths.chatDbPath);
  try {
    const rows = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
    expect(rows.n).toBe(0);
  } finally {
    db.close();
  }
});

test("keepalive rows are silently skipped on backfill (not rendered to the human)", async () => {
  // Seed presence + a keepalive row directly in chat.db. The console's
  // tail-on-start path used to render these as
  // "HH:MM:SS · keepalive — pinged N: <user>", which is infrastructure
  // noise the human admin doesn't want. They should be skipped silently.
  seedSubscriber(paths, "vellumpike", "pantheon");
  const db = openChatDb(paths.chatDbPath);
  try {
    const router = new ChatRouter({ paths, db });
    router.addMessage({
      from_agent_id: "system",
      scope: "dm",
      target: "vellumpike",
      text: "keepalive ping — cache-warming heartbeat, no action needed.",
      system: true,
      system_kind: "keepalive",
    });
  } finally {
    db.close();
  }

  const stdout = new StringSink();
  await runConsole({
    args: ["--tail", "50", "--no-color", "--no-roster"],
    stdin: Readable.from(["/quit\n"]),
    stdout,
    stderr: new StringSink(),
    paths,
  });
  // Neither the "keepalive — pinged" summary line nor the raw body
  // text should leak into the rendered output.
  expect(stdout.buf).not.toContain("keepalive");
  expect(stdout.buf).not.toContain("pinged");
});

test("non-TTY stdin: unknown slash command renders inline error but doesn't exit", async () => {
  const stdout = new StringSink();
  await runConsole({
    args: ["--no-tail", "--no-roster"],
    stdin: Readable.from(["/bogus\nhello\n"]),
    stdout,
    stderr: new StringSink(),
    paths,
  });
  // Slash-command errors render inline (red), not on stderr — chat-mcp parity.
  expect(stdout.buf).toContain("unknown command: /bogus");
  // The subsequent line still broadcasts.
  const db = openChatDb(paths.chatDbPath);
  try {
    const row = db
      .query("SELECT text FROM messages ORDER BY seq DESC LIMIT 1")
      .get() as { text: string } | undefined;
    expect(row?.text).toBe("hello");
  } finally {
    db.close();
  }
});
