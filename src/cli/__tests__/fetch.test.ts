import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
import { runFetch } from "../fetch.ts";
import { EXIT_CODES } from "../exit-codes.ts";

let tmp: string;
let paths: Paths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-fetch-"));
  paths = resolvePaths({ PANTHEON_HOME: tmp } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface CapturedStream extends Writable {
  text: string;
}

function makeStream(): CapturedStream {
  const chunks: string[] = [];
  const s = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as CapturedStream;
  Object.defineProperty(s, "text", {
    get(): string {
      return chunks.join("");
    },
  });
  return s;
}

/** §11c presence-lapse recovery contract: both the startup-lookup-fail
 * path and the mid-loop SessionExpiredError path must converge on exit
 * code PRESENCE_LAPSED (3) and a single parseable stderr line led by
 * `pantheon-fetch: presence_lapsed agent_id=<id>` so agent harnesses
 * and shell wrappers can detect the condition deterministically. */
test("runFetch: no presence row at startup → exit 3 with parseable lapse line", async () => {
  const stderr = makeStream();
  const stdout = makeStream();
  // Touch the chat db so the open succeeds; no subscriber row inserted.
  openChatDb(paths.chatDbPath).close();

  const agent_id = "11111111-2222-3333-4444-555555555555";
  const code = await runFetch({
    args: ["--agent-id", agent_id],
    paths,
    stdout,
    stderr,
  });

  expect(code).toBe(EXIT_CODES.PRESENCE_LAPSED);
  expect(code).toBe(3);
  // Stable leading token + agent_id verbatim.
  expect(stderr.text).toContain(`pantheon-fetch: presence_lapsed agent_id=${agent_id}`);
  // Recovery clause points at the right tool.
  expect(stderr.text).toContain("mcp__pantheon__login");
  // No stray stdout chatter on the error path.
  expect(stdout.text).toBe("");
});

