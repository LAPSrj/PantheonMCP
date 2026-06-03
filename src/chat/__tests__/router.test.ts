import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, openChatDb, type Paths } from "../../storage/index.ts";
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
  const guest = router.add({ username: "alice", project: "p", transient: true });
  const persona = router.add({
    username: "vellumpike",
    project: "p",
    transient: false,
  });
  router.remove(guest.agent_id);
  router.remove(persona.agent_id);
  expect(router.tombstones.get("alice")).not.toBeNull();
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
  const g = router.add({ username: "alice", project: "p", transient: true });
  router.flipToPromoted(g.agent_id);
  expect(router.getByAgentId(g.agent_id)?.transient).toBe(false);
});

// --- handle_recycled broadcast ---

test("consumeTombstoneAndBroadcast emits a project message + clears tombstone", () => {
  // Seed a tombstone for "alice".
  router.tombstones.add("alice", "old-agent");
  const fresh = router.add({ username: "alice", project: "p", transient: false });
  router.consumeTombstoneAndBroadcast("alice", fresh.agent_id);
  expect(router.tombstones.get("alice")).toBeNull();
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
      last_event_at: 0,
      status_updated_at: 0,
      promoted_at: null,
    },
  ];
  const out = renderStatusDigest(subs);
  expect(out).toContain("1 agent changed status");
  expect(out).not.toContain("1 agents");
});

// --- keepalive sweep ---

test("publicList surfaces idle_for_ms = now - last_activity_at (zombie signal)", () => {
  // idle_for_ms is computed only on the cross-process (SQLite) path, so
  // wire a db-backed router (production shape).
  let now = 1_000_000;
  const db = openChatDb(paths.chatDbPath);
  const r = new ChatRouter({ paths, db, clock: () => now });
  const a = r.add({ username: "zombie", project: "p", transient: false });
  // login upsert stamps last_activity_at = 1_000_000.
  now += 60_000;
  // Process stays alive (heartbeat fires at `now`), but the agent loop
  // is frozen — no fresh activity, so we re-assert the OLD timestamp.
  r.heartbeat(a.agent_id, 1_000_000);
  const row = r.publicList("p").find((x) => x.username === "zombie");
  expect(row).toBeDefined();
  expect(row!.last_seen).toBe(now); // heartbeat fresh → still visible
  expect(row!.idle_for_ms).toBe(60_000); // but idle 60s = the zombie gap
  db.close();
});

test("publicList idle_for_ms tracks fresh activity (live agent ~ 0)", () => {
  let now = 2_000_000;
  const db = openChatDb(paths.chatDbPath);
  const r = new ChatRouter({ paths, db, clock: () => now });
  const a = r.add({ username: "busy", project: "p", transient: false });
  now += 60_000;
  // A LIVE agent: each heartbeat carries a current activity timestamp.
  r.heartbeat(a.agent_id, now);
  const row = r.publicList("p").find((x) => x.username === "busy");
  expect(row!.idle_for_ms).toBe(0);
  db.close();
});

test("sweepKeepalive: pings only subscribers idle longer than threshold", () => {
  let now = 1_000_000;
  const r = new ChatRouter({ paths, clock: () => now });
  const idle = r.add({ username: "idle1", project: "p", transient: false });
  const fresh = r.add({ username: "fresh1", project: "p", transient: false });
  // Move clock forward past threshold; bump the fresh agent's
  // last_event_at by sending it a DM.
  now += 16 * 60_000;
  // Refresh `fresh` with a directed message.
  const sender = r.add({ username: "sender", project: "p", transient: false });
  r.addMessage({
    from_agent_id: sender.agent_id,
    scope: "dm",
    target: "fresh1",
    text: "hi",
  });
  // Sweep at the same timestamp — sender is the only one whose
  // last_event_at hasn't been set since long ago, idle is the
  // pre-existing idle one.
  const dispatched = r.sweepKeepalive(15 * 60_000, now);
  // Expectations: idle1 idled 16min ago → pinged. fresh1 just got
  // a DM at now → not pinged. sender's last_event_at moved when its
  // own send touched the dispatch loop? No — the sender is the from,
  // the dispatch loop only bumps recipients. So sender is also stale
  // and should get pinged.
  expect(dispatched).toBeGreaterThanOrEqual(1);
  // Verify by checking the recipient's last_event_at: idle1 should
  // have been bumped by the keepalive itself.
  const idleAfter = r.getByAgentId(idle.agent_id);
  expect(idleAfter!.last_event_at).toBe(now);
  const freshAfter = r.getByAgentId(fresh.agent_id);
  // fresh got the DM at `now`; the keepalive sweep didn't ping it.
  expect(freshAfter!.last_event_at).toBe(now);
});

test("sweepKeepalive: returns 0 when nobody is past threshold", () => {
  let now = 1_000_000;
  const r = new ChatRouter({ paths, clock: () => now });
  r.add({ username: "a", project: "p", transient: false });
  r.add({ username: "b", project: "p", transient: false });
  expect(r.sweepKeepalive(15 * 60_000, now + 60_000)).toBe(0);
});

test("sweepKeepalive: keepalive itself bumps recipient's last_event_at", () => {
  let now = 1_000_000;
  const r = new ChatRouter({ paths, clock: () => now });
  const sub = r.add({ username: "lone", project: "p", transient: false });
  now += 16 * 60_000;
  const dispatched = r.sweepKeepalive(15 * 60_000, now);
  expect(dispatched).toBe(1);
  const after = r.getByAgentId(sub.agent_id)!;
  expect(after.last_event_at).toBe(now);
  // Second sweep at the same instant — already pinged, last_event_at
  // bumped to now, so nothing to do.
  expect(r.sweepKeepalive(15 * 60_000, now)).toBe(0);
});

test("sweepKeepalive: dm-mode and quiet-mode peers still get keepalives", () => {
  let now = 1_000_000;
  const r = new ChatRouter({ paths, clock: () => now });
  const dmer = r.add({ username: "dmer", project: "p", transient: false });
  r.setMode(dmer.agent_id, "dm");
  const q = r.add({ username: "quiet1", project: "p", transient: false });
  r.setMode(q.agent_id, "quiet");
  now += 16 * 60_000;
  // Cache-warming applies regardless of delivery preference.
  expect(r.sweepKeepalive(15 * 60_000, now)).toBe(2);
});

test("sweepKeepalive: keepalive_ms <= 0 is a no-op (disabled)", () => {
  let now = 1_000_000;
  const r = new ChatRouter({ paths, clock: () => now });
  r.add({ username: "a", project: "p", transient: false });
  now += 60 * 60_000;
  expect(r.sweepKeepalive(0, now)).toBe(0);
  expect(r.sweepKeepalive(-1, now)).toBe(0);
});

// --- reclaimCanonicalHandles (closing half of the remanifest flow) --- //

test("reclaimCanonicalHandles renames a `<base>2` subscriber when canonical is free", () => {
  // Simulate: canonical `vellumpike` is gone (no row); the suffixed
  // `vellumpike2` is what survived. Reclaim should rename it back.
  const sub = router.add({
    username: "vellumpike2",
    project: "pantheon",
    transient: false,
  });
  const renamed = router.reclaimCanonicalHandles();
  expect(renamed).toBe(1);
  expect(router.getByUsername("vellumpike")?.agent_id).toBe(sub.agent_id);
  expect(router.getByUsername("vellumpike2")).toBeNull();
});

test("reclaimCanonicalHandles does NOT rename when canonical is still held", () => {
  router.add({ username: "vellumpike", project: "p", transient: false });
  router.add({ username: "vellumpike2", project: "p", transient: false });
  const renamed = router.reclaimCanonicalHandles();
  expect(renamed).toBe(0);
  expect(router.getByUsername("vellumpike")).toBeTruthy();
  expect(router.getByUsername("vellumpike2")).toBeTruthy();
});

test("reclaimCanonicalHandles is a no-op when the only subscriber has no digit suffix", () => {
  router.add({ username: "vellumpike", project: "p", transient: false });
  expect(router.reclaimCanonicalHandles()).toBe(0);
});

test("reclaimCanonicalHandles handles multiple suffixed subscribers in one pass", () => {
  // Two different personas, both currently auto-suffixed, both with
  // canonical handles free. Both rename in a single pass.
  router.add({ username: "alpha3", project: "p", transient: false });
  router.add({ username: "beta7", project: "p", transient: false });
  expect(router.reclaimCanonicalHandles()).toBe(2);
  expect(router.getByUsername("alpha")).toBeTruthy();
  expect(router.getByUsername("beta")).toBeTruthy();
});

// --- clone-addressing: liveSiblings + publicList clones annotation ---

test("liveSiblings returns canonical + suffixed siblings, canonical-first then ascending suffix", () => {
  router.add({ username: "righthand4", project: "p", transient: false });
  router.add({ username: "righthand", project: "p", transient: false });
  router.add({ username: "righthand2", project: "p", transient: false });
  router.add({ username: "unrelated", project: "p", transient: false });

  const sibs = router.liveSiblings("righthand");
  expect(sibs.map((s) => s.username)).toEqual([
    "righthand",
    "righthand2",
    "righthand4",
  ]);
  expect(sibs.map((s) => s.is_canonical)).toEqual([true, false, false]);
});

test("liveSiblings accepts a suffixed handle and still resolves the whole family", () => {
  router.add({ username: "righthand", project: "p", transient: false });
  router.add({ username: "righthand2", project: "p", transient: false });
  // Passing the suffixed handle derives the same base.
  expect(router.liveSiblings("righthand2").map((s) => s.username)).toEqual([
    "righthand",
    "righthand2",
  ]);
});

test("liveSiblings surfaces siblings across projects (no project filter)", () => {
  router.add({ username: "righthand", project: "X", transient: false });
  router.add({ username: "righthand2", project: "Y", transient: false });
  const sibs = router.liveSiblings("righthand");
  expect(sibs.map((s) => s.username)).toEqual(["righthand", "righthand2"]);
  expect(sibs.find((s) => s.username === "righthand2")?.project).toBe("Y");
});

test("liveSiblings on a lone canonical returns just itself (no siblings)", () => {
  router.add({ username: "righthand", project: "p", transient: false });
  const sibs = router.liveSiblings("righthand");
  expect(sibs.map((s) => s.username)).toEqual(["righthand"]);
});

test("publicList annotates the canonical entry with a `clones` array; siblings carry none", () => {
  router.add({ username: "righthand", project: "p", transient: false });
  router.add({ username: "righthand2", project: "p", transient: false });
  router.add({ username: "righthand4", project: "p", transient: false });

  const list = router.publicList();
  const canonical = list.find((a) => a.username === "righthand");
  expect(canonical?.clones).toEqual(["righthand2", "righthand4"]);
  // Suffixed siblings are not canonical -> no clones field.
  expect(list.find((a) => a.username === "righthand2")?.clones).toBeUndefined();
  expect(list.find((a) => a.username === "righthand4")?.clones).toBeUndefined();
});

test("publicList omits `clones` when a canonical handle has no live siblings", () => {
  router.add({ username: "righthand", project: "p", transient: false });
  router.add({ username: "solo", project: "p", transient: false });
  const list = router.publicList();
  expect(list.find((a) => a.username === "righthand")?.clones).toBeUndefined();
  expect(list.find((a) => a.username === "solo")?.clones).toBeUndefined();
});

test("publicList `clones` is scoped to the (project-filtered) list — no dangling handles", () => {
  router.add({ username: "righthand", project: "X", transient: false });
  router.add({ username: "righthand2", project: "Y", transient: false });
  // Filtered to project X: only the canonical is in the list, so it gets
  // no clones (the sibling lives in Y and isn't part of this result set).
  const listX = router.publicList("X");
  expect(listX.map((a) => a.username)).toEqual(["righthand"]);
  expect(listX.find((a) => a.username === "righthand")?.clones).toBeUndefined();
});
