import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { ChatError, ChatRouter } from "../index.ts";

let tmpDir: string;
let paths: Paths;
let router: ChatRouter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-router-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  router = new ChatRouter({ paths });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- subscriber lifecycle ---

test("add creates a subscriber with a fresh agent_id", () => {
  const sub = router.add({
    username: "vellumpike",
    project: "pantheon",
    transient: false,
  });
  expect(sub.agent_id.length).toBeGreaterThan(0);
  expect(sub.transient).toBe(false);
  expect(router.getByUsername("vellumpike")?.agent_id).toBe(sub.agent_id);
});

test("add rejects collisions via ChatError", () => {
  router.add({ username: "vellumpike", project: "p", transient: false });
  expect(() =>
    router.add({ username: "vellumpike", project: "p", transient: false }),
  ).toThrow(ChatError);
});

test("remove drops a guest and lays a tombstone; persona leaves no tombstone", () => {
  const guest = router.add({ username: "leandro", project: "p", transient: true });
  const persona = router.add({
    username: "vellumpike",
    project: "p",
    transient: false,
  });
  router.remove(guest.agent_id);
  router.remove(persona.agent_id);
  expect(router.tombstones.get("leandro")).not.toBeNull();
  expect(router.tombstones.get("vellumpike")).toBeNull();
});

// --- message dispatch ---

test("DM is visible to target only; other subscribers don't get it", () => {
  const a = router.add({ username: "alpha", project: "p", transient: false });
  const b = router.add({ username: "beta", project: "p", transient: false });
  const c = router.add({ username: "gamma", project: "p", transient: false });
  router.addMessage({
    from_agent_id: a.agent_id,
    scope: "dm",
    target: "beta",
    text: "psst",
  });
  expect(router.takeMessages(b.agent_id).messages.map((m) => m.text)).toEqual(["psst"]);
  expect(router.takeMessages(c.agent_id).messages).toEqual([]);
});

test("project-scope messages are visible to same-project peers only", () => {
  const a = router.add({ username: "alpha", project: "X", transient: false });
  const b = router.add({ username: "beta", project: "X", transient: false });
  const c = router.add({ username: "gamma", project: "Y", transient: false });
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "team" });
  expect(router.takeMessages(b.agent_id).messages.map((m) => m.text)).toEqual(["team"]);
  expect(router.takeMessages(c.agent_id).messages).toEqual([]);
});

test("global scope reaches everyone except the sender", () => {
  const a = router.add({ username: "alpha", project: "X", transient: false });
  const b = router.add({ username: "beta", project: "Y", transient: false });
  router.addMessage({ from_agent_id: a.agent_id, scope: "global", text: "all hands" });
  expect(router.takeMessages(b.agent_id).messages).toHaveLength(1);
  expect(router.takeMessages(a.agent_id).messages).toEqual([]);
});

test("mode 'dm' suppresses project chatter; mention still gets through", () => {
  const a = router.add({ username: "alpha", project: "X", transient: false });
  const b = router.add({ username: "beta", project: "X", transient: false });
  router.setMode(b.agent_id, "dm");
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "general chat" });
  expect(router.takeMessages(b.agent_id).messages).toEqual([]);
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "hey @beta look" });
  expect(router.takeMessages(b.agent_id).messages.map((m) => m.text)).toEqual(["hey @beta look"]);
});

test("mode 'quiet' filters system events but keeps user messages", () => {
  const a = router.add({ username: "alpha", project: "X", transient: false });
  const b = router.add({ username: "beta", project: "X", transient: false });
  router.setMode(b.agent_id, "quiet");
  router.addMessage({
    from_agent_id: "system",
    scope: "project",
    project: "X",
    text: "alpha joined",
    system: true,
    system_kind: "join",
  });
  router.addMessage({ from_agent_id: a.agent_id, scope: "project", text: "real message" });
  expect(router.takeMessages(b.agent_id).messages.map((m) => m.text)).toEqual(["real message"]);
});

// --- ask / answer ---

test("ask resolves when the target answers", async () => {
  const a = router.add({ username: "asker", project: "p", transient: false });
  const t = router.add({ username: "target", project: "p", transient: false });
  const askPromise = router.ask({
    from_agent_id: a.agent_id,
    target_username: "target",
    text: "what time?",
    timeout_ms: 1000,
  });
  // Find the ask's correlation_id from the question delivered to target.
  const incoming = router.takeMessages(t.agent_id).messages;
  expect(incoming).toHaveLength(1);
  const askId = incoming[0]!.ask_id!;
  router.answer({ from_agent_id: t.agent_id, correlation_id: askId, text: "noon" });
  const result = await askPromise;
  expect(result.status).toBe("answered");
  if (result.status === "answered") {
    expect(result.text).toBe("noon");
    expect(result.from).toBe("target");
  }
});

test("ask resolves with respondent_disconnected when target leaves before answering", async () => {
  const a = router.add({ username: "asker", project: "p", transient: false });
  const t = router.add({ username: "target", project: "p", transient: false });
  const askPromise = router.ask({
    from_agent_id: a.agent_id,
    target_username: "target",
    text: "?",
    timeout_ms: 5000,
  });
  router.remove(t.agent_id);
  const result = await askPromise;
  expect(result.status).toBe("timeout");
  if (result.status === "timeout") {
    expect(result.reason).toBe("respondent_disconnected");
  }
});

test("ask refuses guests as targets", () => {
  const a = router.add({ username: "asker", project: "p", transient: false });
  router.add({ username: "ghost", project: "p", transient: true });
  expect(() =>
    router.ask({
      from_agent_id: a.agent_id,
      target_username: "ghost",
      text: "?",
    }),
  ).toThrow(ChatError);
});

// --- promote-in-place ---

test("flipToPromoted clears transient flag on a guest", () => {
  const g = router.add({ username: "leandro", project: "p", transient: true });
  router.flipToPromoted(g.agent_id);
  expect(router.getByAgentId(g.agent_id)?.transient).toBe(false);
});

// --- handle_recycled broadcast ---

test("consumeTombstoneAndBroadcast emits a project message + clears tombstone", () => {
  // Seed a tombstone for "leandro".
  router.tombstones.add("leandro", "old-agent");
  const fresh = router.add({ username: "leandro", project: "p", transient: false });
  router.consumeTombstoneAndBroadcast("leandro", fresh.agent_id);
  expect(router.tombstones.get("leandro")).toBeNull();
  // No subscriber other than `fresh` exists, so no one receives the
  // broadcast — but the message is recorded and was emitted.
});

// --- status digest ---

test("renderStatusDigest groups by project, sorts by username, marks mode tags", async () => {
  const { renderStatusDigest } = await import("../router.ts");
  const subs = [
    { username: "zeta", project: "X", mode: "all", status: "deep work" },
    { username: "alpha", project: "X", mode: "quiet", status: "Reviewing infra" },
    { username: "beta", project: "Y", mode: "dm", status: "" },
  ].map((s) => ({
    agent_id: `id-${s.username}`,
    transient: false,
    connected_at: 0,
    last_seen: 0,
    status_updated_at: 0,
    promoted_at: null,
    ...s,
  })) as never as Parameters<typeof renderStatusDigest>[0];
  const out = renderStatusDigest(subs);
  expect(out).toContain("status_digest — 3 agents changed status");
  // Project headers present + sorted lexically.
  const xIdx = out.indexOf("[X]");
  const yIdx = out.indexOf("[Y]");
  expect(xIdx).toBeGreaterThanOrEqual(0);
  expect(yIdx).toBeGreaterThan(xIdx);
  // Within X: alpha sorted before zeta. Mode tags applied.
  expect(out).toContain("alpha[Q] — Reviewing infra");
  expect(out).toContain("zeta — deep work");
  // Empty status renders as "(empty)" so digests don't look broken.
  expect(out).toContain("beta[D] — (empty)");
  // alpha appears before zeta in the X section (alphabetical).
  expect(out.indexOf("alpha[Q]")).toBeLessThan(out.indexOf("zeta —"));
});

// --- channels ---

test("router.add accepts supports_channels and persists it on the subscriber", () => {
  const sub = router.add({
    username: "alpha",
    project: "ops",
    transient: false,
    supports_channels: true,
  });
  expect(sub.supports_channels).toBe(true);
});

test("router.add: supports_channels defaults to false when omitted", () => {
  const sub = router.add({ username: "alpha", project: "ops", transient: false });
  expect(sub.supports_channels).toBe(false);
});

test("router.subscribe fires for messages visible to the agent (channel push hook seam)", () => {
  const alpha = router.add({ username: "alpha", project: "ops", transient: false, supports_channels: true });
  const beta = router.add({ username: "beta", project: "ops", transient: false });
  const received: string[] = [];
  router.subscribe(alpha.agent_id, (m) => {
    received.push(m.text);
  });
  // Message from beta to project ops — alpha should receive.
  router.addMessage({
    from_agent_id: beta.agent_id,
    scope: "project",
    text: "hello team",
  });
  expect(received).toEqual(["hello team"]);
});

test("renderStatusDigest singular agent count uses 'agent', not 'agents'", async () => {
  const { renderStatusDigest } = await import("../router.ts");
  const subs = [
    {
      agent_id: "id-1",
      username: "alpha",
      project: "X",
      mode: "all" as const,
      status: "deep work",
      transient: false,
      connected_at: 0,
      last_seen: 0,
      status_updated_at: 0,
      promoted_at: null,
    },
  ];
  const out = renderStatusDigest(subs);
  expect(out).toContain("1 agent changed status");
  expect(out).not.toContain("1 agents");
});
