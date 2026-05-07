import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
import { ChatRouter } from "../../chat/index.ts";
import { formatStatusLine, runStatusline } from "../statusline.ts";

let tmpDir: string;
let env: NodeJS.ProcessEnv;
let paths: Paths;

class StringSink extends Writable {
  buf = "";
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-statusline-"));
  env = { PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv;
  paths = resolvePaths(env);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("formatStatusLine: empty list", () => {
  expect(formatStatusLine([])).toContain("no agents online");
});

test("formatStatusLine: groups by project, asterisks guests", () => {
  const line = formatStatusLine([
    {
      agent_id: "1",
      username: "alpha",
      project: "X",
      transient: false,
      mode: "all",
      status: "",
      connected_at: 0,
      status_updated_at: 0,
      last_heartbeat: 0,
      promoted_at: null,
    },
    {
      agent_id: "2",
      username: "alice",
      project: "X",
      transient: true,
      mode: "all",
      status: "",
      connected_at: 0,
      status_updated_at: 0,
      last_heartbeat: 0,
      promoted_at: null,
    },
    {
      agent_id: "3",
      username: "beta",
      project: "Y",
      transient: false,
      mode: "all",
      status: "",
      connected_at: 0,
      status_updated_at: 0,
      last_heartbeat: 0,
      promoted_at: null,
    },
  ]);
  expect(line).toContain("[pantheon 3]");
  expect(line).toContain("X:alpha,alice*");
  expect(line).toContain("Y:beta");
});

test("runStatusline: outputs status line for active subscribers", async () => {
  const db = openChatDb(paths.chatDbPath);
  const router = new ChatRouter({ paths, db });
  router.add({ username: "alpha", project: "X", transient: false });
  db.close();

  const stdout = new StringSink();
  const stderr = new StringSink();
  const code = await runStatusline({ paths, stdout, stderr });
  expect(code).toBe(0);
  expect(stdout.buf).toContain("alpha");
  expect(stdout.buf).toContain("[pantheon");
});

test("runStatusline: silent fallback when chat.db is missing/broken", async () => {
  const stdout = new StringSink();
  const stderr = new StringSink();
  // Point at a broken path — directory exists but chat.db is a junk
  // file that can't be opened as SQLite.
  fs.writeFileSync(paths.chatDbPath, "not-a-sqlite-db");
  const code = await runStatusline({ paths, stdout, stderr });
  expect(code).toBe(0);
  // Stdout still has SOME line so the prompt bar isn't empty.
  expect(stdout.buf.length).toBeGreaterThan(0);
});
