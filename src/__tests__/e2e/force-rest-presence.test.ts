import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";
import { consumeForceLifecycleRequests } from "../../mcp/handlers/lifecycle.ts";
import { listActive } from "../../chat/presence.ts";

/** Regression coverage for the bug fixed in commit 6:
 *
 * `force_rest` was a state-machine-only operation — it flipped the
 * target's session to `resting: true` and stamped `last_rested_at`,
 * but never removed the chat subscriber row. The target's chat
 * watcher (a separate CC `Monitor` task) kept polling and bumping
 * `last_heartbeat`, so `pruneStale`'s 60s TTL never expired, and
 * `list_agents` continued to surface the rested agent as live
 * indefinitely.
 *
 * After the fix: `applyForceRest` removes the subscriber row,
 * causing the watcher's next refresh to surface `SessionExpiredError`
 * and terminate. The "left" message is broadcast to peers, mirroring
 * `logout`'s posture.
 *
 * Self-`rest` deliberately retains presence (agent may resume). */

let fix: E2EFixture;

beforeEach(() => {
  fix = makeFixture();
});

afterEach(() => {
  fix.cleanup();
});

test("force_rest: target's chat subscriber row is removed after the prune-tick consumes the request", async () => {
  // --- Register + claim two personas in the same project ---
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/work/alpha",
    claim_after: true,
  });
  await call(fix.procB, "register", {
    username: "beta",
    project: "pantheon",
    cwd: "/work/beta",
    claim_after: true,
  });

  // --- Both login to chat ---
  await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  const loginB = await call(fix.procB, "login", {
    username: "beta",
    project: "pantheon",
    transient: false,
  });
  expect(loginB.ok).toBe(true);
  const betaAgentId = loginB.payload.agent_id as string;

  // Sanity: beta is in chat presence.
  expect(
    listActive(fix.procB.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === betaAgentId,
    ),
  ).toBe(true);

  // --- alpha force-rests beta ---
  const force = await call(fix.procA, "force_rest", {
    target_username: "beta",
    reason: "ops:test-restore",
  });
  expect(force.ok).toBe(true);

  // Beta is still live BEFORE the prune tick consumes the request.
  expect(
    listActive(fix.procB.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === betaAgentId,
    ),
  ).toBe(true);

  // --- Drive the consume tick on procB's side ---
  const consumed = consumeForceLifecycleRequests(fix.procB.ctx);
  expect(consumed.consumed).toBe(1);
  expect(consumed.rested).toBe(true);

  // Post-condition: subscriber row is gone.
  expect(
    listActive(fix.procB.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === betaAgentId,
    ),
  ).toBe(false);
  // Session state reflects the rest.
  expect(fix.procB.ctx.session.isResting).toBe(true);
  // ctx_agent_id was cleared so a follow-up consume is a no-op.
  expect(fix.procB.ctx.chat_agent_id).toBeNull();
});

test("force_rest broadcasts a system 'left' message into the target's project", async () => {
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/work/alpha",
    claim_after: true,
  });
  await call(fix.procB, "register", {
    username: "beta",
    project: "pantheon",
    cwd: "/work/beta",
    claim_after: true,
  });
  await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  const loginB = await call(fix.procB, "login", {
    username: "beta",
    project: "pantheon",
    transient: false,
  });
  const loginAseq = (loginB.payload.agent_id as string) ? 0 : 0;

  await call(fix.procA, "force_rest", { target_username: "beta" });
  consumeForceLifecycleRequests(fix.procB.ctx);

  // Tail messages from after the login. Alpha's watcher would see
  // the system "left" announcement.
  const { tailOnce } = await import("../../chat/index.ts");
  const events = tailOnce({
    db: fix.procA.db,
    receiver: {
      agent_id: "system-test-reader",
      username: "alpha",
      project: "pantheon",
      mode: "all",
    },
    since_seq: loginAseq,
  });
  const sawForceRestNotice = events.some(
    (e) => e.line.includes("beta") && e.line.includes("force-rested"),
  );
  expect(sawForceRestNotice).toBe(true);
});

test("self-rest does NOT remove chat presence (asymmetric semantics)", async () => {
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/work/alpha",
    claim_after: true,
  });
  const loginA = await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  const alphaAgentId = loginA.payload.agent_id as string;

  await call(fix.procA, "allow_rest");
  const restA = await call(fix.procA, "rest", { reason: "user_done" });
  expect(restA.ok).toBe(true);
  expect(fix.procA.ctx.session.isResting).toBe(true);

  // Presence row should still be there — self-rest is "I may resume,
  // keep me DM-able." Only force-rest evicts.
  expect(
    listActive(fix.procA.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === alphaAgentId,
    ),
  ).toBe(true);
});

test("force_rest is idempotent when target session is already resting", async () => {
  await call(fix.procA, "register", {
    username: "alpha",
    project: "pantheon",
    cwd: "/work/alpha",
    claim_after: true,
  });
  await call(fix.procB, "register", {
    username: "beta",
    project: "pantheon",
    cwd: "/work/beta",
    claim_after: true,
  });
  await call(fix.procA, "login", {
    username: "alpha",
    project: "pantheon",
    transient: false,
  });
  await call(fix.procB, "login", {
    username: "beta",
    project: "pantheon",
    transient: false,
  });

  // First force_rest — consume.
  await call(fix.procA, "force_rest", { target_username: "beta" });
  const first = consumeForceLifecycleRequests(fix.procB.ctx);
  expect(first.consumed).toBe(1);

  // Second force_rest after the target is already rested + de-presenced
  // would have nothing to do (target_username is no longer in active
  // presence, so force_rest itself should reject at the resolver).
  let secondErr: unknown = null;
  try {
    await call(fix.procA, "force_rest", { target_username: "beta" });
  } catch (e) {
    secondErr = e;
  }
  // We expect either a non-ok response payload or a thrown error;
  // either way, the second consume on procB MUST find no pending row.
  void secondErr;
  const second = consumeForceLifecycleRequests(fix.procB.ctx);
  expect(second.consumed).toBe(0);
});
