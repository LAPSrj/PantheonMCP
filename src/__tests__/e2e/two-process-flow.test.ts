import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";
import { tailOnce, type ReceiverState } from "../../chat/index.ts";

let fix: E2EFixture;

beforeEach(() => {
  fix = makeFixture();
});

afterEach(() => {
  fix.cleanup();
});

test("two processes: register → claim → DM → ask/answer → rest → resume → exit", async () => {
  // --- Process A: register + claim alpha ---
  const regA = await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/work/alpha",
    claim_after: true,
  });
  expect(regA.ok).toBe(true);
  expect(fix.procA.ctx.session.claimedUsername).toBe("alpha");

  // --- Process B: register + claim beta (same project) ---
  const regB = await call(fix.procB, "register", {
    username: "beta",
    project: "pantheon",
    cwd: "/work/beta",
    claim_after: true,
  });
  expect(regB.ok).toBe(true);

  // --- Both login to chat ---
  const loginA = await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  expect(loginA.ok).toBe(true);
  const loginB = await call(fix.procB, "login", {
    username: "beta",
    project: "pantheon",
    transient: false,
  });
  expect(loginB.ok).toBe(true);

  // --- A sends DM to B ---
  await call(fix.procA, "send_message", { text: "hi beta", scope: "dm", target: "beta" });

  // --- Cross-process visibility: B's watcher sees the DM via SQLite ---
  // (`check_messages` is currently in-process-only — it reads the
  // router's in-memory recent buffer, not chat.db. Cross-process
  // real-time delivery flows through the watcher loop, which tails
  // SQLite. Promoting check_messages to cross-process is tracked as
  // a follow-up.)
  const { tailOnce } = await import("../../chat/index.ts");
  const watcherEvents = tailOnce({
    db: fix.procB.db,
    receiver: {
      agent_id: loginB.payload.agent_id as string,
      username: "beta",
      project: "pantheon",
      mode: "all",
    },
    since_seq: 0,
  });
  expect(
    watcherEvents.some((e) => e.line.includes("hi beta") && e.line.includes("[likely reply]")),
  ).toBe(true);

  // ask/answer cross-router is a known limitation (the pendingAsks
  // correlation map lives in the asker's router instance). The
  // standalone "ask/answer round trip" test below covers the path
  // within a single router.

  // --- A goes to rest (must allow_rest first since not summoned) ---
  await call(fix.procA, "allow_rest");
  const restA = await call(fix.procA, "rest", { reason: "user_done" });
  expect(restA.ok).toBe(true);
  expect(fix.procA.ctx.session.isResting).toBe(true);

  // --- B summons A with resume:true ---
  // First simulate A having stamped a resume_session_id during rest
  // (the resume tool would set this; simulate via direct registry).
  const { writePersona, readPersona } = await import("../../identity/index.ts");
  const personaA = readPersona(fix.paths, "alpha");
  if (personaA) writePersona(fix.paths, { ...personaA, resume_session_id: "session-xyz" });

  const summon = await call(fix.procB, "summon", {
    username: "alpha",
    resume: true,
    prompt: "back at it",
  });
  expect(summon.ok).toBe(true);
  expect(fix.procB.spawned).toHaveLength(1);
  const argv = fix.procB.spawned[0]!.args;
  expect(argv).toContain("--resume");
  expect(argv).toContain("session-xyz");
  expect(argv).toContain("back at it");
  expect(fix.procB.spawned[0]!.env.PANTHEON_USERNAME).toBe("alpha");

  // --- Both exit ---
  const exitA = await call(fix.procA, "exit", { delay_seconds: 0 });
  expect(exitA.ok).toBe(true);
  const exitB = await call(fix.procB, "exit", { delay_seconds: 0 });
  expect(exitB.ok).toBe(true);
});

test("ask/answer round trip within a single process (router correlation map)", async () => {
  // Demonstrates the working ask/answer path. The cross-process
  // limitation (pendingAsks lives in a single router instance) is
  // documented; promoting it would need shared ask state, deferred.
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/a",
    claim_after: true,
  });
  await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  // Create a second subscriber inside A's router to act as the
  // target. Use a non-persona handle so the chat-router's persona-
  // impersonation guard (registered_persona reject) doesn't fire.
  const targetSub = fix.procA.ctx.chat!.add({
    username: "betagoblin",
    project: "pantheon",
    transient: false,
  });

  // Fire ask + answer within the same router.
  const askPromise = (async () => {
    return await fix.procA.ctx.chat!.ask({
      from_agent_id: fix.procA.ctx.chat_agent_id!,
      target_username: "betagoblin",
      text: "ping",
      timeout_ms: 5000,
    });
  })();

  // Find the ask's correlation_id from the message that landed on
  // target's queue.
  const incoming = fix.procA.ctx.chat!.takeMessages(targetSub.agent_id).messages;
  const askId = incoming[0]?.ask_id;
  expect(askId).toBeDefined();
  fix.procA.ctx.chat!.answer({
    from_agent_id: targetSub.agent_id,
    correlation_id: askId!,
    text: "pong",
  });

  const result = await askPromise;
  expect(result?.text).toBe("pong");
  expect(result?.from).toBe("betagoblin");
});

test("watcher loop sees DMs + system events across processes", async () => {
  // A registers + logs in.
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/a",
    claim_after: true,
  });
  const loginA = await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  // B registers + logs in (its `join` event becomes visible in the
  // chat history; A's watcher loop should pick it up as a silent event).
  await call(fix.procB, "register", {
    username: "beta",
    project: "pantheon",
    cwd: "/b",
    claim_after: true,
  });
  await call(fix.procB, "login", {
    username: "beta",
    project: "pantheon",
    transient: false,
  });
  // B sends a DM to A.
  await call(fix.procB, "send_message", {
    text: "hello alpha",
    scope: "dm",
    target: "alpha",
  });

  // Now run A's watcher in one-shot mode. Use A's db handle.
  const receiver: ReceiverState = {
    agent_id: loginA.payload.agent_id as string,
    username: "alpha",
    project: "pantheon",
    mode: "all",
  };
  const events = tailOnce({ db: fix.procA.db, receiver, since_seq: 0 });
  // We expect at minimum:
  //  - silent-event coalescing for the system join events (alpha's, beta's)
  //  - a [likely reply] line for the DM from B
  const lines = events.map((e) => e.line);
  expect(lines.some((l) => l.includes("<silent-event"))).toBe(true);
  expect(lines.some((l) => l.includes("[likely reply]") && l.includes("hello alpha"))).toBe(true);
});

test("identity-leak guard: register({force:true, claim_after:false}) does NOT switch session", async () => {
  // A claims alpha.
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/work/alpha",
    claim_after: true,
  });
  expect(fix.procA.ctx.session.claimedUsername).toBe("alpha");

  // A registers a different handle with force:true and claim_after omitted
  // (defaults to false per §13).
  const r = await call(fix.procA, "register", {
    username: "epsilon",
    project: "pantheon",
    cwd: "/work/epsilon",
    force: true,
  });
  expect(r.ok).toBe(true);
  expect(r.payload.claimed).toBe(false);
  expect(r.payload.note).toContain("'epsilon'");
  expect(r.payload.note).toContain("'alpha'");
  expect(fix.procA.ctx.session.claimedUsername).toBe("alpha");

  // The new persona DID land in the registry (other processes see it).
  const { listPersonas } = await import("../../identity/index.ts");
  const all = listPersonas(fix.paths).map((p) => p.username).sort();
  expect(all).toEqual(["alpha", "epsilon"]);
});
