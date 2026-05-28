import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Database } from "bun:sqlite";
import { resolvePaths } from "../../storage/index.ts";
import { openChatDb } from "../../storage/sqlite.ts";
import { Session, createPersona } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { ChatRouter } from "../../chat/index.ts";
import {
  type SpawnExecutor,
  type SpawnedProcess,
} from "../../launcher/index.ts";
import {
  getSummon,
  pendingSummonsForSummoner,
  confirmSummon,
} from "../../lifecycle/index.ts";
import { createContext } from "../context.ts";
import { spawnPersona, sweepSummonVerifications } from "../handlers/spawn.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let db: Database;
let router: ChatRouter;
let ctx: HandlerContext;
let recorder: SpawnRecord[];
let summonerAgentId: string;

interface SpawnRecord {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function makeMockExecutor(): SpawnExecutor {
  return {
    spawn(command, args, options): SpawnedProcess {
      recorder.push({
        command,
        args,
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
      return { pid: 12345, stderr: null as unknown as NodeJS.ReadableStream, unref() {} };
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-summon-verify-"));
  recorder = [];
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  db = openChatDb(paths.chatDbPath);
  router = new ChatRouter({ paths, db });
  // The summoner is itself a logged-in chat agent — it owns the verify
  // sweep and receives the failure DM.
  const summoner = router.add({
    username: "summoner-x",
    project: "pantheon",
    transient: false,
  });
  summonerAgentId = summoner.agent_id;
  ctx = createContext({
    paths,
    session: new Session("summoner-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    spawn_executor: makeMockExecutor(),
    stderr_probe_ms: 5,
    spawn_env: {} as NodeJS.ProcessEnv,
    chat: router,
  });
  ctx.setChatAgentId(summonerAgentId);
  createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "pantheon",
    cwd: "/work/moth",
    platform: "linux",
    description: "peer",
    expertise: ["chat"],
    owns: ["/x"],
    launch_command: "claude",
    launch_args: ["--print"],
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function summon() {
  const p = (await import("../../identity/index.ts")).readPersona(
    ctx.paths,
    "moth-whistle",
  )!;
  return spawnPersona({ username: "moth-whistle", prompt: "go" }, ctx, p);
}

function summonFailedMessages() {
  return db
    .query("SELECT target_username, text FROM messages WHERE kind = 'summon_failed'")
    .all() as { target_username: string; text: string }[];
}

test("summon writes a pending row and injects PANTHEON_SUMMON_ID", async () => {
  await summon();
  const pending = pendingSummonsForSummoner(db, summonerAgentId);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.target_username).toBe("moth-whistle");

  const env = recorder[0]!.env!;
  expect(env.PANTHEON_SUMMON_ID).toBe(pending[0]!.id);
});

test("sweep within the boot window does nothing", async () => {
  await summon();
  const id = pendingSummonsForSummoner(db, summonerAgentId)[0]!.id;
  const spawnedAt = getSummon(db, id)!.spawned_at;
  // now only 30s past spawn — inside the 120s window.
  await sweepSummonVerifications(ctx, { now: spawnedAt + 30_000 });
  expect(recorder).toHaveLength(1); // no re-spawn
  expect(getSummon(db, id)!.state).toBe("pending");
  expect(getSummon(db, id)!.retries).toBe(0);
});

test("confirmed summon (child logged in) is never retried", async () => {
  await summon();
  const id = pendingSummonsForSummoner(db, summonerAgentId)[0]!.id;
  confirmSummon(db, id, "child-agent");
  const spawnedAt = getSummon(db, id)!.spawned_at;
  await sweepSummonVerifications(ctx, { now: spawnedAt + 999_999 });
  expect(recorder).toHaveLength(1); // no re-spawn
  expect(getSummon(db, id)!.state).toBe("confirmed");
});

test("sweep past the window re-spawns once, reusing the same nonce", async () => {
  await summon();
  const id = pendingSummonsForSummoner(db, summonerAgentId)[0]!.id;
  const spawnedAt = getSummon(db, id)!.spawned_at;

  await sweepSummonVerifications(ctx, { now: spawnedAt + 130_000 });

  expect(recorder).toHaveLength(2); // re-spawned
  const row = getSummon(db, id)!;
  expect(row.retries).toBe(1);
  expect(row.state).toBe("pending");
  // Retry carries the SAME nonce → the re-spawned child confirms the
  // same row.
  expect(recorder[1]!.env!.PANTHEON_SUMMON_ID).toBe(id);
  expect(summonFailedMessages()).toHaveLength(0); // not failed yet
});

test("sweep past the window after the retry is exhausted fails + notifies", async () => {
  await summon();
  const id = pendingSummonsForSummoner(db, summonerAgentId)[0]!.id;
  const t0 = getSummon(db, id)!.spawned_at;

  // First sweep past window → retry (retries 0 -> 1).
  await sweepSummonVerifications(ctx, { now: t0 + 130_000 });
  const t1 = getSummon(db, id)!.spawned_at; // reset to t0 + 130_000

  // Second sweep past the new window → retries == max → fail + notify.
  await sweepSummonVerifications(ctx, { now: t1 + 130_000 });

  const row = getSummon(db, id)!;
  expect(row.state).toBe("failed");
  expect(recorder).toHaveLength(2); // no third spawn

  const msgs = summonFailedMessages();
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.target_username).toBe("summoner-x"); // DM to the summoner
  expect(msgs[0]!.text).toContain("moth-whistle");
});

test("verify:false skips the row and the env injection", async () => {
  const p = (await import("../../identity/index.ts")).readPersona(
    ctx.paths,
    "moth-whistle",
  )!;
  await spawnPersona({ username: "moth-whistle", prompt: "go" }, ctx, p, {
    verify: false,
  });
  expect(pendingSummonsForSummoner(db, summonerAgentId)).toHaveLength(0);
  expect(recorder[0]!.env!.PANTHEON_SUMMON_ID).toBeUndefined();
});
