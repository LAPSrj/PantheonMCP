import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";
import { consumeForceLifecycleRequests } from "../../mcp/handlers/lifecycle.ts";
import { listActive } from "../../chat/presence.ts";

/** Symmetric coverage for `applyForceExit`.
 *
 * Pre-fix: `applyForceExit` scheduled SIGTERM but left the target's
 * chat presence row in SQLite. The row aged out 60s after the
 * heartbeat stopped, leaving peers seeing a ghost subscriber for
 * up to a minute — and, more importantly, blocking canonical-handle
 * reclaim on `remanifest` (the NEW session boots auto-suffixed
 * because OLD's row is still fresh in `allKnownSubscribers`).
 *
 * Post-fix: `applyForceExit` mirrors `applyForceRest` — drops chat
 * presence + emits a system "leave" + clears chat_agent_id BEFORE
 * scheduling the SIGTERM. */

let fix: E2EFixture;

beforeEach(() => {
  fix = makeFixture();
});

afterEach(() => {
  fix.cleanup();
});

test("force_exit: target's chat subscriber row is removed synchronously when the prune-tick consumes the request", async () => {
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
  expect(loginB.ok).toBe(true);
  const betaAgentId = loginB.payload.agent_id as string;

  // Sanity: beta is in presence.
  expect(
    listActive(fix.procB.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === betaAgentId,
    ),
  ).toBe(true);

  // --- alpha force-exits beta ---
  const force = await call(fix.procA, "force_exit", {
    target_username: "beta",
    reason: "ops:canonical-reclaim",
  });
  expect(force.ok).toBe(true);

  // Pre-consume: still live (rest_request hasn't been picked up yet).
  expect(
    listActive(fix.procB.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === betaAgentId,
    ),
  ).toBe(true);

  // --- Drive the consume tick on procB's side ---
  const consumed = consumeForceLifecycleRequests(fix.procB.ctx);
  expect(consumed.consumed).toBe(1);
  expect(consumed.exiting).toBe(true);

  // Post-condition: subscriber row is gone — peers no longer see beta.
  expect(
    listActive(fix.procB.db, { stale_threshold_ms: 60_000 }).some(
      (s) => s.agent_id === betaAgentId,
    ),
  ).toBe(false);

  // chat_agent_id cleared so heartbeat scheduler stops upserting.
  expect(fix.procB.ctx.chat_agent_id).toBeNull();
});

test("force_exit broadcasts a system 'force-exited' message into the target's project", async () => {
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

  await call(fix.procA, "force_exit", { target_username: "beta" });
  consumeForceLifecycleRequests(fix.procB.ctx);

  const { tailOnce } = await import("../../chat/index.ts");
  const events = tailOnce({
    db: fix.procA.db,
    receiver: {
      agent_id: "system-test-reader",
      username: "alpha",
      project: "pantheon",
      mode: "all",
    },
    since_seq: 0,
  });
  const sawNotice = events.some(
    (e) => e.line.includes("beta") && e.line.includes("force-exited"),
  );
  expect(sawNotice).toBe(true);
});

test("force_exit canonical-reclaim path: auto-suffixed NEW session reclaims canonical immediately after OLD's force-exit consume", async () => {
  // Reproduces the remanifest flow at the router level: NEW session
  // boots auto-suffixed because OLD still has the canonical row,
  // then OLD's prune-tick consumes a force_exit and drops the row,
  // then NEW's reclaimCanonicalHandles renames back to canonical.
  // Pre-fix this required waiting ~60s for the presence row to age
  // out; post-fix it's available the moment OLD's consume runs.
  await call(fix.procA, "register", {
    username: "wraith",
    project: "pantheon",
    cwd: "/work/wraith",
    claim_after: true,
  });

  // OLD session (procA) logs in as canonical "wraith".
  const oldLogin = await call(fix.procA, "login", {
    username: "wraith",
    project: "pantheon",
    transient: false,
  });
  expect(oldLogin.ok).toBe(true);
  expect(oldLogin.payload.username).toBe("wraith");

  // NEW session (procB) is a peer process for the same persona.
  // Register it at the same cwd so the auto-claim path doesn't reject
  // it as `registered_persona` for a different process.
  await call(fix.procB, "register", {
    username: "wraith",
    project: "pantheon",
    cwd: "/work/wraith",
    claim_after: true,
  });
  // NEW logs in — finds canonical taken by OLD → auto-suffixes.
  const newLogin = await call(fix.procB, "login", {
    username: "wraith",
    project: "pantheon",
    transient: false,
  });
  expect(newLogin.ok).toBe(true);
  expect(newLogin.payload.auto_suffixed).toEqual({
    intended: "wraith",
    assigned: "wraith2",
  });
  expect(newLogin.payload.username).toBe("wraith2");

  // Simulate the remanifest signal: NEW writes force_exit for OLD.
  // (In real remanifest this is done implicitly in the login handler
  // via PANTHEON_REMANIFEST_OF; here we use the public tool.)
  const force = await call(fix.procB, "force_exit", { target_username: "wraith" });
  expect(force.ok).toBe(true);

  // OLD's prune-tick consumes the force_exit → drops presence row.
  const consumed = consumeForceLifecycleRequests(fix.procA.ctx);
  expect(consumed.exiting).toBe(true);

  // Canonical handle is now free in the merged view — NEW's prune-tick
  // reclaims it.
  const renamed = fix.procB.ctx.chat!.reclaimCanonicalHandles();
  expect(renamed).toBe(1);

  // NEW's subscriber is now "wraith" canonical.
  const newAgentId = newLogin.payload.agent_id as string;
  const me = fix.procB.ctx.chat!.getByAgentId(newAgentId);
  expect(me?.username).toBe("wraith");
});
