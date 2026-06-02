import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { createContext } from "../context.ts";
import { getEntry, loadStore } from "../../memory/index.ts";
import { arm_watcher, claim_watcher, close_watcher } from "../handlers/watcher.ts";
import type { ChatRouter } from "../../chat/index.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;
const USER = "vellumpike";

/** Minimal chat stub exposing only what the watcher handlers touch. */
function chatStub(live: string[]): ChatRouter {
  return { liveAgentIds: () => new Set(live) } as unknown as ChatRouter;
}

function makeCtx(agentId: string | null, live: string[]): HandlerContext {
  const session = new Session("s1", {
    kind: "claimed_persona",
    username: USER,
    resting: false,
  } as never);
  const c = createContext({
    paths: resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv),
    session,
    chat: chatStub(live),
  });
  c.setChatAgentId(agentId);
  return c;
}

const REARM = { crons: ["0 */6 * * * poll"], notes: "ledger /tmp/x.md" };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-wh-"));
  ctx = makeCtx("agentA", ["agentA"]);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("arm_watcher binds owner_agent_id + canonical persona and persists kind:watcher", async () => {
  const res = (await arm_watcher(
    { topic: "liaison-watch", text: "CP package poll", rearm: REARM },
    ctx,
  )) as Record<string, unknown>;
  expect(res.owner_agent_id).toBe("agentA");
  expect(res.owner_username).toBe(USER);
  expect(res.scope).toBe("persona");
  const stored = getEntry(ctx.paths, USER, res.id as string)!;
  expect(stored.kind).toBe("watcher");
  expect(stored.watcher?.owner_agent_id).toBe("agentA");
  expect(stored.watcher?.rearm.crons).toEqual(["0 */6 * * * poll"]);
});

test("arm_watcher requires a chat login (owner binding is the live agent_id)", async () => {
  const noChat = makeCtx(null, []);
  await expect(
    arm_watcher({ topic: "liaison-watch", text: "x", rearm: REARM }, noChat),
  ).rejects.toThrow(/logged into chat/);
});

test("arm_watcher rejects an empty re-arm payload", async () => {
  await expect(
    arm_watcher({ topic: "liaison-watch", text: "x", rearm: {} }, ctx),
  ).rejects.toThrow(/rearm/);
});

test("arm_watcher rejects project scope (deferred fast-follow)", async () => {
  await expect(
    arm_watcher(
      { topic: "liaison-watch", text: "x", rearm: REARM, scope: "project" },
      ctx,
    ),
  ).rejects.toThrow(/not wired/);
});

test("arm_watcher requires a topic (durable kind)", async () => {
  await expect(
    arm_watcher({ text: "x", rearm: REARM } as Record<string, unknown>, ctx),
  ).rejects.toThrow();
});

test("claim_watcher wins on an orphan and returns the re-arm payload", async () => {
  const armed = (await arm_watcher(
    { topic: "liaison-watch", text: "CP poll", rearm: REARM }, ctx,
  )) as Record<string, unknown>;
  // A sibling B claims after A is gone (live set no longer has agentA).
  const ctxB = makeCtx("agentB", ["agentB"]);
  const res = (await claim_watcher({ id: armed.id }, ctxB)) as Record<string, unknown>;
  expect(res.won).toBe(true);
  expect((res.rearm as { crons: string[] }).crons).toEqual(["0 */6 * * * poll"]);
  expect(getEntry(ctx.paths, USER, armed.id as string)!.watcher?.owner_agent_id).toBe("agentB");
});

test("claim_watcher loses cleanly when a live owner already holds it", async () => {
  const armed = (await arm_watcher(
    { topic: "liaison-watch", text: "CP poll", rearm: REARM }, ctx,
  )) as Record<string, unknown>;
  // Owner agentA is still live → not orphaned → C loses.
  const ctxC = makeCtx("agentC", ["agentA", "agentC"]);
  const res = (await claim_watcher({ id: armed.id }, ctxC)) as Record<string, unknown>;
  expect(res.won).toBe(false);
  expect(res.reason).toBe("not_orphaned");
  expect(res.owner_agent_id).toBe("agentA");
});

test("close_watcher fades a watcher; rejects a non-watcher id", async () => {
  const armed = (await arm_watcher(
    { topic: "liaison-watch", text: "CP poll", rearm: REARM }, ctx,
  )) as Record<string, unknown>;
  const res = (await close_watcher({ id: armed.id }, ctx)) as Record<string, unknown>;
  expect(res.status).toBe("faded");
  expect(loadStore(ctx.paths, USER).entries.find((e) => e.id === armed.id)!.status).toBe("faded");

  await expect(close_watcher({ id: "does/not-exist" }, ctx)).rejects.toThrow(/No watcher/);
});
