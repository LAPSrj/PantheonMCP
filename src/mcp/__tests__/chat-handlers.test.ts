import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openChatDb, resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { ChatRouter } from "../../chat/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import { statuslineSidecarPath } from "../../cli/statusline-sidecar.ts";
import type { HandlerContext } from "../types.ts";
import type { Database } from "bun:sqlite";

let tmpDir: string;
let ctx: HandlerContext;
// Optional db handle a test can open to wire ctx.chat with a real
// SQLite backing (e.g. schema-registry tests). Closed in afterEach
// when set. Most tests leave this null and run with an in-memory
// router.
let ctxChatDb: Database | null = null;

/** Replace ctx.chat with a db-backed router. Idempotent within a
 * single test — call once before exercising schema-registry tools. */
function useDbBackedRouter(): void {
  ctxChatDb = openChatDb(ctx.paths.chatDbPath);
  // Augment the existing ctx with a router that points at the same db.
  // Casting through Mutable<HandlerContext> would be over-engineered for
  // a test helper; the field is `readonly` only at the type level.
  (ctx as { chat: ChatRouter }).chat = new ChatRouter({
    paths: ctx.paths,
    db: ctxChatDb,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-chat-handlers-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    chat: new ChatRouter({ paths }),
  });
});

afterEach(() => {
  if (ctxChatDb) {
    ctxChatDb.close();
    ctxChatDb = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(tool: string, args: Record<string, unknown> = {}) {
  const r = await dispatch(tool, args, ctx);
  return {
    ok: !r.isError,
    payload: JSON.parse(r.content[0]!.text) as Record<string, unknown>,
  };
}

// --- login / logout ---

test("login as a guest succeeds and sets chat_agent_id on the context", async () => {
  const r = await call("login", {
    username: "alice",
    project: "ops",
    transient: true,
    status: "exploring",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.transient).toBe(true);
  expect(r.payload.username).toBe("alice");
  expect(typeof r.payload.agent_id).toBe("string");
  expect(ctx.chat_agent_id).toBe(r.payload.agent_id as string);
});

test("login + logout clears chat_agent_id", async () => {
  await call("login", { username: "alice", project: "ops", transient: true });
  expect(ctx.chat_agent_id).not.toBeNull();
  const r = await call("logout");
  expect(r.ok).toBe(true);
  expect(ctx.chat_agent_id).toBeNull();
});

test("login: supports_channels=false returns watcher-instruction note + channels_enabled=false", async () => {
  const r = await call("login", {
    username: "alpha",
    project: "ops",
    transient: false,
  });
  expect(r.ok).toBe(true);
  expect(r.payload.channels_enabled).toBe(false);
  expect(r.payload.note).toContain("pantheon-fetch");
  expect(r.payload.note).not.toContain("Channels ARE enabled");
});

test("login: supports_channels=true returns channels-enabled note + channels_enabled=true + persists on subscriber", async () => {
  const r = await call("login", {
    username: "alpha",
    project: "ops",
    transient: false,
    supports_channels: true,
  });
  expect(r.ok).toBe(true);
  expect(r.payload.channels_enabled).toBe(true);
  expect(r.payload.note).toContain("Channels ARE enabled");
  expect(r.payload.note).toContain("<channel source=\"pantheon\"");
  // The channels-enabled template explicitly tells the agent NOT to
  // spawn the watcher (instead of the watcher-only template that
  // tells them to start it).
  expect(r.payload.note).toContain("No Monitor watcher needed");
  expect(r.payload.note).toContain("Do NOT spawn");
  // Persisted on the subscriber so the dispatch path can branch.
  expect(ctx.chat?.getByUsername("alpha")?.supports_channels).toBe(true);
});

test("login collision: returns enriched error with options + suggested_suffix; does NOT auto-evict", async () => {
  // First login takes the handle.
  const first = await call("login", {
    username: "swoopfinch",
    project: "ops",
    transient: true,
  });
  expect(first.ok).toBe(true);
  // Second session tries the same handle; chat router rejects.
  // Build a second session for clarity.
  const sess2 = new Session("test-session-2");
  const ctx2 = createContext({
    paths: ctx.paths,
    session: sess2,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  const r = await dispatch(
    "login",
    { username: "swoopfinch", project: "ops", transient: true },
    ctx2,
  );
  expect(r.isError).toBe(true);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.error).toBe("username_taken");
  // Three remediation options spelled out.
  const options = payload.options as string[];
  expect(options).toBeInstanceOf(Array);
  expect(options).toHaveLength(3);
  expect(options[0]).toContain("Close the OTHER session");
  expect(options[1]).toContain("Close THIS pane");
  expect(options[2]).toContain("--chat-username-suffix");
  // suggested_suffix is the next-free `<base><N>` (typically 2).
  expect(payload.suggested_suffix).toBe("swoopfinch2");
  // Critical: the OTHER session is NOT evicted.
  expect(payload.do_not_auto_logout).toContain("DO NOT call `logout`");
  // The first agent stays subscribed.
  expect(ctx.chat?.getByUsername("swoopfinch")).not.toBeNull();
});

test("login collision: suggested_suffix walks past taken numbers", async () => {
  // Take swoopfinch + swoopfinch2 + swoopfinch3 first.
  for (const u of ["swoopfinch", "swoopfinch2", "swoopfinch3"]) {
    const sess = new Session(`s-${u}`);
    const c = createContext({
      paths: ctx.paths,
      session: sess,
      watchdog: ctx.watchdog,
      parent_pid: ctx.parent_pid,
      platform: ctx.platform,
      chat: ctx.chat,
    });
    await dispatch("login", { username: u, project: "ops", transient: true }, c);
  }
  // Now try swoopfinch from yet another session — suggested should be 4.
  const sess4 = new Session("test-session-4");
  const ctx4 = createContext({
    paths: ctx.paths,
    session: sess4,
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  const r = await dispatch(
    "login",
    { username: "swoopfinch", project: "ops", transient: true },
    ctx4,
  );
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.suggested_suffix).toBe("swoopfinch4");
});

// --- auto-suffix on duplicate-handle login ---

async function registerAndClaim(c: HandlerContext, username: string, project: string) {
  await dispatch(
    "register",
    {
      username,
      project,
      cwd: `/work/${username}`,
      description: `${username} agent`,
      expertise: [],
      owns: [],
      claim_after: true,
    },
    c,
  );
}

async function registerOnly(c: HandlerContext, username: string, project: string, cwd?: string) {
  await dispatch(
    "register",
    {
      username,
      project,
      cwd: cwd ?? `/work/${username}`,
      description: `${username} agent`,
      expertise: [],
      owns: [],
    },
    c,
  );
}

test("auto-claim: unclaimed login at matching cwd auto-claims the persona", async () => {
  // Create a persona registered to THIS process's cwd so the
  // cwd-match safety gate fires.
  await registerOnly(ctx, "amberhowl", "nyus-monitor", process.cwd());
  // Fresh session — never called manifest or claim.
  expect(ctx.session.claimedUsername).toBeNull();

  const r = await call("login", { username: "amberhowl", project: "nyus-monitor" });
  expect(r.ok).toBe(true);
  expect(r.payload.username).toBe("amberhowl");
  expect(r.payload.auto_claimed).toBe(true);
  expect(r.payload.note).toContain("Auto-claimed persona 'amberhowl'");
  // Session is now in claimed_persona state.
  expect(ctx.session.claimedUsername).toBe("amberhowl");
});

test("auto-claim: cwd mismatch falls through to error path", async () => {
  // Persona registered at a DIFFERENT cwd than this process.
  await registerOnly(ctx, "stranger", "p", "/some/other/cwd");
  expect(ctx.session.claimedUsername).toBeNull();

  const r = await dispatch(
    "login",
    { username: "stranger", project: "p", transient: false },
    ctx,
  );
  expect(r.isError).toBe(true);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  // already_registered: persona exists, caller's claim doesn't match,
  // and cwd-match auto-claim didn't fire because cwds differ.
  expect(payload.error).toBe("already_registered");
  expect(payload.auto_claimed).toBeUndefined();
  expect(ctx.session.claimedUsername).toBeNull();
});

test("auto-claim + auto-suffix combine: unclaimed agent at matching cwd whose canonical handle is taken gets <base>2", async () => {
  // First agent claims canonical and joins chat.
  await registerOnly(ctx, "amberhowl", "nyus-monitor", process.cwd());
  await dispatch("claim", { username: "amberhowl" }, ctx);
  await call("login", { username: "amberhowl", project: "nyus-monitor" });

  // Second agent: separate session, never manifested, but lives at
  // the same cwd (because the persona is registered to it). Login
  // should auto-claim AND auto-suffix in one step.
  const ctx2 = createContext({
    paths: ctx.paths,
    session: new Session("test-session-2"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  const r = await dispatch(
    "login",
    { username: "amberhowl", project: "nyus-monitor" },
    ctx2,
  );
  expect(r.isError).toBeFalsy();
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.username).toBe("amberhowl2");
  expect(payload.auto_claimed).toBe(true);
  expect((payload.auto_suffixed as { assigned: string }).assigned).toBe("amberhowl2");
  // Note carries both context messages.
  expect(payload.note).toContain("Auto-claimed persona 'amberhowl'");
  expect(payload.note).toContain("Logged in as 'amberhowl2'");
});

test("auto-suffix: persona-owner whose canonical handle is taken auto-renames to <base>2", async () => {
  // First instance of `semaphoremole` claims the persona and joins chat.
  await registerAndClaim(ctx, "semaphoremole", "liaison");
  const first = await call("login", { username: "semaphoremole", project: "liaison" });
  expect(first.ok).toBe(true);
  expect(first.payload.username).toBe("semaphoremole");

  // Second MCP session — same persona, different process. Persona is
  // already registered by the first registerAndClaim, so this one
  // just claims it.
  const ctx2 = createContext({
    paths: ctx.paths,
    session: new Session("test-session-2"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  await dispatch("claim", { username: "semaphoremole" }, ctx2);

  const second = await dispatch(
    "login",
    { username: "semaphoremole", project: "liaison" },
    ctx2,
  );
  expect(second.isError).toBeFalsy();
  const payload = JSON.parse(second.content[0]!.text) as Record<string, unknown>;
  expect(payload.username).toBe("semaphoremole2");
  const auto = payload.auto_suffixed as { intended: string; assigned: string };
  expect(auto).toEqual({ intended: "semaphoremole", assigned: "semaphoremole2" });
  expect(payload.note).toContain("auto-assigned the next sibling-incarnation slot");
  expect(payload.note).toContain("Logged in as 'semaphoremole2'");
});

test("re-login on the SAME MCP session is idempotent — does NOT auto-suffix", async () => {
  // Repro for the stuck-canonical-handle bug: when /compact (or any
  // bootstrap-reminder loop) re-fires `login` from a session that
  // already has a chat subscriber, the handler must return the
  // existing subscriber rather than allocating a sibling-incarnation
  // slot against its own in-memory row.
  await registerAndClaim(ctx, "carlita", "p");
  const first = await call("login", { username: "carlita", project: "p" });
  expect(first.ok).toBe(true);
  expect(first.payload.username).toBe("carlita");
  const firstAgentId = first.payload.agent_id as string;

  // Same MCP session calls login again with the same username.
  const second = await call("login", { username: "carlita", project: "p" });
  expect(second.ok).toBe(true);
  // Same handle, same agent_id — no auto-suffix, no second subscriber.
  expect(second.payload.username).toBe("carlita");
  expect(second.payload.auto_suffixed).toBeUndefined();
  expect(second.payload.agent_id).toBe(firstAgentId);
  // ctx.chat_agent_id is preserved (no second subscriber created).
  expect(ctx.chat_agent_id).toBe(firstAgentId);
  // Router still has exactly one subscriber for this username.
  const subs = Array.from(ctx.chat!.allSubscribers()).filter(
    (s) => s.username === "carlita",
  );
  expect(subs).toHaveLength(1);
});

test("re-login on the SAME MCP session: status string, when provided, is applied to the existing subscriber", async () => {
  await registerAndClaim(ctx, "carlita", "p");
  await call("login", { username: "carlita", project: "p", status: "phase 1" });
  const sub1 = ctx.chat!.getByUsername("carlita");
  expect(sub1?.status).toBe("phase 1");

  await call("login", { username: "carlita", project: "p", status: "phase 2" });
  const sub2 = ctx.chat!.getByUsername("carlita");
  expect(sub2?.status).toBe("phase 2");
  // Still exactly one subscriber under that handle.
  const all = Array.from(ctx.chat!.allSubscribers()).filter(
    (s) => s.username === "carlita",
  );
  expect(all).toHaveLength(1);
});

test("re-login on the SAME MCP session with a DIFFERENT username is rejected with already_logged_in", async () => {
  await registerAndClaim(ctx, "carlita", "p");
  await call("login", { username: "carlita", project: "p" });
  const r = await call("login", { username: "different_handle", project: "p" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("already_logged_in");
  expect(r.payload.current_username).toBe("carlita");
});

test("auto-suffix: walks past taken slots", async () => {
  await registerAndClaim(ctx, "alice", "p");
  await call("login", { username: "alice", project: "p" });
  // Pre-take alice2 + alice3 by direct router.add (simulates other peers).
  ctx.chat!.add({ username: "alice2", project: "p", transient: false });
  ctx.chat!.add({ username: "alice3", project: "p", transient: false });

  const ctx2 = createContext({
    paths: ctx.paths,
    session: new Session("s2"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  await dispatch("claim", { username: "alice" }, ctx2);
  const r = await dispatch("login", { username: "alice", project: "p" }, ctx2);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.username).toBe("alice4");
  expect((payload.auto_suffixed as { assigned: string }).assigned).toBe("alice4");
});

test("auto-suffix: explicit chat_username_suffix collision falls through to next free canonical slot (no double-concat)", async () => {
  // A summoned agent's bootstrap embeds `chat_username_suffix` so it
  // logs into chat as `<persona><N>` while its MCP session still
  // claims the CANONICAL persona. When that suffixed handle is taken,
  // the auto-suffix correction must walk the next-free-numeric scan
  // rooted on the canonical base — NOT concatenate onto the already-
  // suffixed handle (`righthand2` -> `righthand22`).
  await registerAndClaim(ctx, "righthand", "p");
  await call("login", { username: "righthand", project: "p" });
  // Peers hold righthand2 / righthand3 / righthand4; righthand5 free.
  ctx.chat!.add({ username: "righthand2", project: "p", transient: false });
  ctx.chat!.add({ username: "righthand3", project: "p", transient: false });
  ctx.chat!.add({ username: "righthand4", project: "p", transient: false });

  const ctx2 = createContext({
    paths: ctx.paths,
    session: new Session("s2"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  // ctx2 claims the CANONICAL persona (env-claim equivalent), then
  // logs in as the suffixed handle the bootstrap told it to use.
  await dispatch("claim", { username: "righthand" }, ctx2);
  const r = await dispatch("login", { username: "righthand2", project: "p" }, ctx2);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.username).toBe("righthand5");
  const auto = payload.auto_suffixed as { intended: string; assigned: string };
  expect(auto.assigned).toBe("righthand5");
  // `intended` reports the CANONICAL persona, not the suffixed request.
  expect(auto.intended).toBe("righthand");
});

test("auto-suffix: does NOT trigger for guest (transient) logins", async () => {
  // Guest collisions stay on the manual-options error path — guests
  // have no persona ownership, so picking <base>2 silently could
  // confuse peers about who's actually claiming the namespace.
  await call("login", { username: "guest", project: "p", transient: true });
  const ctx2 = createContext({
    paths: ctx.paths,
    session: new Session("g2"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  const r = await dispatch(
    "login",
    { username: "guest", project: "p", transient: true },
    ctx2,
  );
  expect(r.isError).toBe(true);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.error).toBe("username_taken");
  expect(payload.auto_suffixed).toBeUndefined();
  expect(payload.suggested_suffix).toBe("guest2");
});

test("auto-suffix: does NOT trigger when the canonical handle is owned by a different persona", async () => {
  // Register two personas; both try to claim `mallory` as their chat
  // handle. Second login is `already_registered` (different owner)
  // — this is NOT auto-suffix-able because the caller has no claim
  // on the base name.
  await registerAndClaim(ctx, "mallory", "p");
  await call("login", { username: "mallory", project: "p" });

  const ctx2 = createContext({
    paths: ctx.paths,
    session: new Session("s2"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  await registerAndClaim(ctx2, "trent", "p");
  // ctx2's session claims `trent`, but is trying to chat as `mallory`.
  // The collision reason is `registered_persona` (mallory belongs to
  // someone else), not `subscriber_taken`.
  const r = await dispatch(
    "login",
    { username: "mallory", project: "p", transient: true },
    ctx2,
  );
  expect(r.isError).toBe(true);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  // Either `already_registered` (persona collision) or `username_taken`
  // (subscriber collision via the live mallory) — the auto-suffix
  // path is gated on `subscriber_taken` AND owner-claim, neither of
  // which applies for ctx2.
  expect(payload.auto_suffixed).toBeUndefined();
  expect(payload.options).toBeInstanceOf(Array);
});

test("auto-suffix: join system message marks the rename for peers", async () => {
  await registerAndClaim(ctx, "bob", "p");
  await call("login", { username: "bob", project: "p" });

  const ctx2 = createContext({
    paths: ctx.paths,
    session: new Session("s2"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
  });
  await dispatch("claim", { username: "bob" }, ctx2);
  // Add a peer to receive the join broadcast.
  const peer = ctx.chat!.add({ username: "watcher", project: "p", transient: false });
  await dispatch("login", { username: "bob", project: "p" }, ctx2);

  const taken = ctx.chat!.takeMessages(peer.agent_id);
  const joinMsg = taken.messages.find(
    (m) => m.system_kind === "join" && m.text.includes("bob2"),
  );
  expect(joinMsg).toBeDefined();
  expect(joinMsg!.text).toContain("sibling-incarnation of bob");
  expect(joinMsg!.text).toContain("canonical handle held by another live session");
});

test("login with promote flips guest → claimed_persona via promoteInPlace", async () => {
  const r = await call("login", {
    username: "alice",
    project: "ops",
    transient: true,
    promote: {
      project: "ops",
      description: "ops human",
      expertise: ["bash"],
      owns: ["/ops"],
    },
  });
  expect(r.ok).toBe(true);
  expect(r.payload.promoted).toBe(true);
  // The subscriber is created as a guest; promote then flips it.
  // The response surfaces `promoted: true` rather than re-asserting
  // the initial transient flag (which has already been overwritten
  // by the in-place flip).
  expect(r.payload.username).toBe("alice");
  // Subscriber state should now be non-transient.
  expect(ctx.chat?.getByUsername("alice")?.transient).toBe(false);
});

// --- send_message + scopes ---

test("send_message persists + delivers to project peers", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // Add a peer directly on the router so we can verify delivery.
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const sent = await call("send_message", { text: "hello team" });
  expect(sent.ok).toBe(true);

  const taken = ctx.chat!.takeMessages(peer.agent_id);
  expect(taken.messages.map((m) => m.text)).toContain("hello team");
});

test("send_message with scope='dm' requires a target", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", { text: "psst", scope: "dm" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("missing_target");
});

test("send_message: DM to an online peer succeeds and delivers", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const target = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: "beta",
  });
  expect(r.ok).toBe(true);
  const taken = ctx.chat!.takeMessages(target.agent_id);
  expect(taken.messages.map((m) => m.text)).toContain("psst");
});

test("send_message: DM to an offline target fails recipient_offline + does NOT persist", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // No `gamma` ever added — strictly offline.
  const r = await call("send_message", {
    text: "ghost-DM",
    scope: "dm",
    target: "gamma",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("recipient_offline");
  expect((r.payload.message as string)).toContain("not currently in chat");
  expect((r.payload.message as string)).toContain("NOT persisted");
  // Bonus: re-running list of in-memory messages by-id confirms the
  // router never accepted the send (no message_id surfaced in the
  // error payload — the failure is pre-addMessage).
  expect(r.payload.message_id).toBeUndefined();
});

// --- inverse guard: `target` on a non-dm send is a misdirected DM -- //

test("send_message: target + default (project) scope is rejected with target_requires_dm", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // A live peer named `beta` exists — irrelevant; the guard fires on
  // scope, not on recipient liveness.
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", { text: "meant for beta", target: "beta" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("target_requires_dm");
  // Nothing persisted — the guard is pre-addMessage.
  expect(r.payload.message_id).toBeUndefined();
});

test("send_message: target + scope='global' is rejected with target_requires_dm", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", {
    text: "meant for beta",
    scope: "global",
    target: "beta",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("target_requires_dm");
});

test("send_message: target + scope='dm' still succeeds (guard does not over-fire)", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const target = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", { text: "psst", scope: "dm", target: "beta" });
  expect(r.ok).toBe(true);
  expect(ctx.chat!.takeMessages(target.agent_id).messages.map((m) => m.text)).toContain("psst");
});

test("send_message: no target + project scope still succeeds (guard does not over-fire)", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", { text: "hello team" });
  expect(r.ok).toBe(true);
});

test("send_structured: target + non-dm scope is rejected with target_requires_dm", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_structured", {
    kind: "pushback",
    payload: { x: 1 },
    target: "beta",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("target_requires_dm");
});

// --- DM resolver: educational errors for agent_id-as-target -------- //

test("send_message: DM with agent_id (full UUID) where live subscriber exists → agent_id_not_username", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const target = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: target.agent_id,
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("agent_id_not_username");
  expect((r.payload.message as string)).toContain("'beta'");
  expect((r.payload.message as string)).toContain("agent_id");
  expect(r.payload.resolved_username).toBe("beta");
});

test("send_message: DM with agent_id prefix (8 chars) matching one live subscriber → agent_id_not_username", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const target = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const prefix = target.agent_id.slice(0, 8);
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: prefix,
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("agent_id_not_username");
  expect(r.payload.resolved_username).toBe("beta");
});

test("send_message: DM with hex prefix matching 2+ subscribers → ambiguous_agent_id", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // Both subs are added with random UUIDs; we contrive overlap by
  // computing the common leading-hex slice across two NEW adds via the
  // router. Most agent_ids share at least one hex digit at position 0,
  // so a 1-char prefix is reliably ambiguous when 2+ subs exist.
  const beta = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const gamma = ctx.chat!.add({ username: "gamma", project: "X", transient: false });
  // Find the longest common prefix that's still hex-shape and ≥ 4 chars.
  // Falls back to skipping if the two ids share no 4-char prefix.
  let commonPrefix = "";
  for (let i = 0; i < beta.agent_id.length && i < gamma.agent_id.length; i++) {
    if (beta.agent_id[i] === gamma.agent_id[i]) commonPrefix += beta.agent_id[i];
    else break;
  }
  if (commonPrefix.length < 4) {
    // Skip: the random ids don't happen to overlap enough this run.
    return;
  }
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: commonPrefix,
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("ambiguous_agent_id");
  const candidates = r.payload.candidates as string[];
  expect(candidates).toContain("beta");
  expect(candidates).toContain("gamma");
});

test("send_message: DM with UUID-shape target but no live match → agent_id_not_live", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: "deadbeef-1234-5678-9abc-deadbeefcafe",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("agent_id_not_live");
  expect((r.payload.message as string)).toContain("looks like an agent_id");
});

test("send_message: DM with username-shape target that's not live → recipient_offline (unchanged)", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: "ghosthand",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("recipient_offline");
});

test("send_message: DM to a registered-but-offline persona → enriched recipient_offline", async () => {
  const { createPersona } = await import("../../identity/registry.ts");
  createPersona(ctx.paths, {
    username: "righthandzero",
    project: "Y",
    cwd: "/tmp/righthand",
    platform: "linux",
    description: "remote peer",
    expertise: [],
    owns: [],
  });
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: "righthandzero",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("recipient_offline");
  const msg = r.payload.message as string;
  expect(msg).toContain("registered persona but not currently in chat");
  expect((r.payload as { registered?: boolean }).registered).toBe(true);
});

test("send_message: DM to an entirely-unknown handle → recipient_offline with registered:false", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", {
    text: "psst",
    scope: "dm",
    target: "ghosthand",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("recipient_offline");
  const msg = r.payload.message as string;
  expect(msg).toContain("no registered persona by that name");
  expect((r.payload as { registered?: boolean }).registered).toBe(false);
});

// --- clone-addressing: soft hint + inverse false-offline ----------- //

test("send_message: DM to a canonical handle with live siblings DELIVERS + surfaces a clone hint", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const canonical = ctx.chat!.add({ username: "righthand", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand2", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand4", project: "X", transient: false });
  const r = await call("send_message", {
    text: "for the canonical",
    scope: "dm",
    target: "righthand",
  });
  expect(r.ok).toBe(true);
  // Delivered (not blocked).
  expect(ctx.chat!.takeMessages(canonical.agent_id).messages.map((m) => m.text)).toContain(
    "for the canonical",
  );
  const hints = (r.payload.hints as string[]) ?? [];
  const cloneHint = hints.find((h) => h.includes("live clone"));
  expect(cloneHint).toBeDefined();
  expect(cloneHint).toContain("'righthand2'");
  expect(cloneHint).toContain("'righthand4'");
});

test("send_message: DM to a SUFFIXED handle is specific — no clone hint", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand", project: "X", transient: false });
  const sib = ctx.chat!.add({ username: "righthand2", project: "X", transient: false });
  const r = await call("send_message", {
    text: "for the sibling",
    scope: "dm",
    target: "righthand2",
  });
  expect(r.ok).toBe(true);
  expect(ctx.chat!.takeMessages(sib.agent_id).messages.map((m) => m.text)).toContain(
    "for the sibling",
  );
  const hints = (r.payload.hints as string[]) ?? [];
  expect(hints.find((h) => h.includes("live clone"))).toBeUndefined();
});

test("send_message: DM to a canonical with NO live siblings → no clone hint", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand", project: "X", transient: false });
  const r = await call("send_message", {
    text: "solo canonical",
    scope: "dm",
    target: "righthand",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[]) ?? [];
  expect(hints.find((h) => h.includes("live clone"))).toBeUndefined();
});

test("send_structured: DM to a canonical with live siblings also surfaces the clone hint", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand2", project: "X", transient: false });
  const r = await call("send_structured", {
    kind: "note",
    payload: { x: 1 },
    scope: "dm",
    target: "righthand",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[]) ?? [];
  expect(hints.find((h) => h.includes("live clone"))?.includes("'righthand2'")).toBe(true);
});

test("send_message: inverse false-offline — canonical not live but siblings are → recipient_offline naming the siblings", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // Canonical `righthand` never logs in; only suffixed siblings are live.
  ctx.chat!.add({ username: "righthand2", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand4", project: "X", transient: false });
  const r = await call("send_message", {
    text: "who am I even reaching",
    scope: "dm",
    target: "righthand",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("recipient_offline");
  const msg = r.payload.message as string;
  expect(msg).toContain("isn't currently in chat");
  expect(msg).toContain("'righthand2'");
  expect(msg).toContain("'righthand4'");
  expect((r.payload as { canonical_offline?: boolean }).canonical_offline).toBe(true);
  // Nothing persisted — the send still fails (no canonical to deliver to).
  expect(r.payload.message_id).toBeUndefined();
});

// --- project-broadcast clarity warnings ---------------------------- //

test("send_message: project broadcast with no peers surfaces an emptyProject warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", {
    text: "hello team",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = r.payload.hints as string[] | undefined;
  expect(hints).toBeDefined();
  expect(hints!.some((h) => h.includes("No other live subscribers on project 'X'"))).toBe(true);
});

test("send_message: project broadcast with peers does NOT surface emptyProject warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "hello team",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(hints.some((h) => h.includes("No other live subscribers"))).toBe(false);
});

test("send_message: project broadcast with exactly one @mention surfaces single-mention warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@beta can you review?",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = r.payload.hints as string[] | undefined;
  expect(hints).toBeDefined();
  expect(hints!.some((h) => h.includes("addressed to exactly one peer (@beta)"))).toBe(true);
});

test("send_message: an over-length message surfaces the relay-truncation hint", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const longText = "x".repeat(450); // > the 400-char default relay cap
  const r = await call("send_message", { text: longText, scope: "project" });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[]) ?? [];
  const relay = hints.find((h) => h.includes("relay cap"));
  expect(relay).toBeDefined();
  expect(relay).toContain("get_message");
  expect(relay).toContain("450");
});

test("send_message: a short message does NOT surface the relay-truncation hint", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", { text: "all good", scope: "project" });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[]) ?? [];
  expect(hints.some((h) => h.includes("relay cap"))).toBe(false);
});

// --- self-truncation guard ---

test("send_message: a self-truncated body (get_message continuation marker) is rejected + does NOT persist", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text:
      "1. first finding\n2. second finding\n\n(Message continues — call get_message for full content)",
    scope: "dm",
    target: "beta",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("self_truncated_message");
  expect(typeof r.payload.message).toBe("string");
  expect(r.payload.marker).toBeDefined();
  // Nothing was persisted — no message_id/seq came back.
  expect(r.payload.message_id).toBeUndefined();
});

test("send_message: assorted self-truncation markers are all rejected", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const bad = [
    "findings so far... to be continued",
    "see the rest below [truncated]",
    "audit continues in a follow-up message",
    "part 1 of 2 [...]",
  ];
  for (const text of bad) {
    const r = await call("send_message", { text, scope: "dm", target: "beta" });
    expect(r.ok).toBe(false);
    expect(r.payload.error).toBe("self_truncated_message");
  }
});

test("send_message: third-person tooling talk mentioning get_message is NOT rejected (guard does not over-fire)", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text:
      "When a relay arrives oversized, call get_message with the seq to read the full body — " +
      "the watcher only stubs the streamed line, the stored text is complete.",
    scope: "dm",
    target: "beta",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.message_id).toBeDefined();
});

test("send_structured: a self-truncated text body is rejected", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_structured", {
    kind: "audit",
    text: "two of five findings here. (message continues — call get_message)",
    payload: { found: 5 },
    scope: "dm",
    target: "beta",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("self_truncated_message");
});

test("send_message: project broadcast with two @mentions does NOT surface single-mention warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  ctx.chat!.add({ username: "gamma", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@beta and @gamma — quick sync?",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(hints.some((h) => h.includes("addressed to exactly one peer"))).toBe(false);
});

test("send_message: @-mention of an offline name doesn't count toward the single-mention warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@nonexistent_user has a question",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  // 0 live mentions in the body → no warning.
  expect(hints.some((h) => h.includes("addressed to exactly one peer"))).toBe(false);
});

test("send_message: self-@-mention is excluded from the single-mention warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@alpha checking in publicly",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(hints.some((h) => h.includes("addressed to exactly one peer"))).toBe(false);
});

test("send_message: DM scope does not trigger any project-broadcast warnings", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@beta direct",
    scope: "dm",
    target: "beta",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(hints.some((h) => h.includes("No other live subscribers"))).toBe(false);
  expect(hints.some((h) => h.includes("addressed to exactly one peer"))).toBe(false);
});

test("send_message: @mention of a live peer on a DIFFERENT project surfaces cross-project warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // Local peer so the empty-project warning doesn't also fire — keeps
  // the assertion focused on the cross-project hint.
  ctx.chat!.add({ username: "delta", project: "X", transient: false });
  ctx.chat!.add({ username: "righthand", project: "Y", transient: false });
  const r = await call("send_message", {
    text: "@righthand can you review?",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(
    hints.some(
      (h) =>
        h.includes("Cross-project mention") &&
        h.includes("@righthand") &&
        h.includes("project 'Y'") &&
        h.includes("'X'"),
    ),
  ).toBe(true);
  // Same-project single-mention warning should NOT fire — the only
  // mention is on another project.
  expect(hints.some((h) => h.includes("addressed to exactly one peer"))).toBe(false);
});

test("send_message: same-project @mention does NOT trigger cross-project warning", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@beta quick q",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(hints.some((h) => h.includes("Cross-project mention"))).toBe(false);
});

test("send_message: single unknown @mention in project broadcast surfaces the unknown-handle hint", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@nobody have you seen the latest spec?",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(
    hints.some(
      (h) => h.includes("@nobody") && h.includes("no live subscriber"),
    ),
  ).toBe(true);
});

test("send_message: unknown-handle hint is suppressed when any live mention exists", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_message", {
    text: "@beta + @nobody — heads up",
    scope: "project",
  });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  // Live mention drives the single-mention warning; unknown hint stays
  // out of the way to avoid double-noise.
  expect(hints.some((h) => h.includes("no live subscriber"))).toBe(false);
});

test("get_message: returns the full row by id", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const sent = await call("send_message", {
    text: "hello beta",
    scope: "dm",
    target: "beta",
  });
  // Persistence is tied to the router's db. The test harness uses an
  // in-memory router (no db wired), so get_message will open a fresh
  // chat.db at the resolved path — which is the test tmpdir's
  // chat.db. We persist a row directly via the router's persistence
  // layer to ensure it lands in the same db get_message reads.
  const messageId = sent.payload.message_id as string;
  // Directly persist to chat.db at the resolved path so get_message
  // can find it (router in this test isn't db-backed).
  const { openChatDb } = await import("../../storage/index.ts");
  const db = openChatDb(ctx.paths.chatDbPath);
  db.run(
    "INSERT INTO messages (id, seq, ts, scope, project, target_username, from_agent_id, from_transient, from_username_inline, text, kind, reply_to, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      messageId,
      1,
      Date.now(),
      "dm",
      "X",
      "beta",
      "system",
      0,
      null,
      "hello beta",
      null,
      null,
      null,
    ],
  );
  db.close();

  const r = await call("get_message", { message_id: messageId });
  expect(r.ok).toBe(true);
  expect(r.payload.id).toBe(messageId);
  expect(r.payload.text).toBe("hello beta");
  expect(r.payload.scope).toBe("dm");
});

test("get_message: unknown id returns not_found", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("get_message", { message_id: "ghost-id" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("not_found");
});

test("get_message: returns the full row by seq (watcher-prefix recovery path)", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const { openChatDb } = await import("../../storage/index.ts");
  const db = openChatDb(ctx.paths.chatDbPath);
  db.run(
    "INSERT INTO messages (id, seq, ts, scope, project, target_username, from_agent_id, from_transient, from_username_inline, text, kind, reply_to, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["by-seq-id", 4242, Date.now(), "dm", "X", "alpha", "system", 0, null, "recover me by seq", null, null, null],
  );
  db.close();

  const r = await call("get_message", { seq: 4242 });
  expect(r.ok).toBe(true);
  expect(r.payload.id).toBe("by-seq-id");
  expect(r.payload.seq).toBe(4242);
  expect(r.payload.text).toBe("recover me by seq");
});

test("get_message: neither message_id nor seq → invalid_args", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("get_message", {});
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("get_message: both message_id and seq → invalid_args", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("get_message", { message_id: "x", seq: 1 });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
});

test("get_message: unknown seq returns not_found", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("get_message", { seq: 999999 });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("not_found");
});

test("ask: offline target fails recipient_offline immediately (no timeout wait)", async () => {
  await call("login", { username: "asker", project: "p", transient: false });
  const t0 = Date.now();
  const r = await dispatch(
    "ask",
    { target: "ghost", text: "?", timeout_ms: 5000 },
    ctx,
  );
  const elapsed = Date.now() - t0;
  // Must fail fast, not eat the 5s timeout budget.
  expect(elapsed).toBeLessThan(500);
  expect(r.isError).toBe(true);
  const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  expect(payload.error).toBe("recipient_offline");
});

// --- ask / answer ---

test("ask resolves when the target answers", async () => {
  await call("login", { username: "asker", project: "p", transient: false });
  const target = ctx.chat!.add({ username: "target", project: "p", transient: false });
  // Fire the ask; it returns a promise we await separately to allow
  // the answer to land in between.
  const askPromise = dispatch(
    "ask",
    { target: "target", text: "what time?", timeout_ms: 5000 },
    ctx,
  );
  // Find the correlation id from the message dispatched to target.
  const incoming = ctx.chat!.takeMessages(target.agent_id).messages;
  expect(incoming).toHaveLength(1);
  const askId = incoming[0]!.ask_id!;
  ctx.chat!.answer({ from_agent_id: target.agent_id, correlation_id: askId, text: "noon" });
  const result = await askPromise;
  const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  expect(payload.text).toBe("noon");
  expect(payload.from).toBe("target");
});

test("ask returns timeout when the target disconnects", async () => {
  await call("login", { username: "asker", project: "p", transient: false });
  const target = ctx.chat!.add({ username: "target", project: "p", transient: false });
  const askPromise = dispatch(
    "ask",
    { target: "target", text: "?", timeout_ms: 5000 },
    ctx,
  );
  ctx.chat!.remove(target.agent_id);
  const result = await askPromise;
  const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  expect(payload.status).toBe("timeout");
});

test("answer to a disconnected asker fails recipient_offline; no row persisted", async () => {
  // Cross-process semantics: an asker fired an ask (persisted in
  // chat.db), then disconnected (presence row pruned). When the target
  // tries to answer, the answer would be a silent drop — pantheon
  // refuses with recipient_offline, matching the send_message /
  // send_structured / ask contract. Exercises the SQLite-backed code
  // path (listActive freshness check) since the in-memory pendingAsks
  // entry is cleaned by router.remove.
  const { openChatDb } = await import("../../storage/index.ts");
  const dbPath = path.join(tmpDir, "answer-offline.db");
  const chatDb = openChatDb(dbPath);
  try {
    const { ChatRouter } = await import("../../chat/index.ts");
    const router = new ChatRouter({ paths: ctx.paths, db: chatDb });

    const asker = router.add({ username: "asker-offline", project: "p", transient: false });
    const target = router.add({ username: "target-online", project: "p", transient: false });
    // Persist an ASK row addressed to target, with correlation_id set.
    const askId = "test-ask-id-correlate";
    router.addMessage({
      from_agent_id: asker.agent_id,
      scope: "dm",
      target: "target-online",
      text: "still there?",
      ask_id: askId,
    });

    // Asker disconnects — both in-memory + presence row gone.
    router.remove(asker.agent_id);

    // Target's answer should throw recipient_offline. Match on the
    // ChatError.code field (not message string) so the contract Leandro
    // pinned is what's asserted.
    const { ChatError } = await import("../../chat/index.ts");
    let caught: InstanceType<typeof ChatError> | null = null;
    try {
      router.answer({
        from_agent_id: target.agent_id,
        correlation_id: askId,
        text: "yes",
      });
    } catch (err) {
      if (err instanceof ChatError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("recipient_offline");

    // No answer row landed in chat.db: only the original ask should
    // exist on this correlation_id.
    const rows = chatDb
      .query("SELECT COUNT(*) AS n FROM messages WHERE correlation_id = ?")
      .get(askId) as { n: number };
    expect(rows.n).toBe(1);
  } finally {
    chatDb.close();
  }
});

// --- list_agents + find_role ---

test("list_agents lists connected subscribers", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("list_agents");
  expect(r.payload.count).toBe(2);
});

test("find_role joins persona registry with online status", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const { createPersona } = await import("../../identity/index.ts");
  createPersona(ctx.paths, {
    username: "moth-whistle",
    project: "X",
    cwd: "/repos/chat-mcp",
    platform: "linux",
    expertise: ["chat-routing"],
    owns: ["/repos/chat-mcp"],
  });
  const r = await call("find_role", { expertise: "chat-routing" });
  expect(r.ok).toBe(true);
  const personas = r.payload.personas as Array<{ username: string; online: boolean }>;
  expect(personas.map((p) => p.username)).toContain("moth-whistle");
  // moth-whistle is registered but not connected — online should be false.
  expect(personas.find((p) => p.username === "moth-whistle")?.online).toBe(false);
});

// --- check_messages + set_mode + update_status ---

test("check_messages pulls pending messages and advances cursor", async () => {
  const me = await call("login", { username: "alpha", project: "X", transient: false });
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  ctx.chat!.addMessage({ from_agent_id: peer.agent_id, scope: "project", text: "hi alpha" });

  const r = await call("check_messages");
  // Includes the explicit "hi alpha" plus the system `join` event for
  // the peer that was added after login.
  expect((r.payload.count as number)).toBeGreaterThanOrEqual(1);
  const messages = r.payload.messages as Array<{ text: string }>;
  expect(messages.some((m) => m.text === "hi alpha")).toBe(true);
  // Second call returns empty (cursor advanced).
  const r2 = await call("check_messages");
  expect(r2.payload.count).toBe(0);
  // (suppress unused linter)
  void me;
});

test("set_mode flips delivery mode", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("set_mode", { mode: "quiet" });
  expect(r.ok).toBe(true);
  expect(r.payload.mode).toBe("quiet");
  expect(ctx.chat?.getByAgentId(ctx.chat_agent_id!)?.mode).toBe("quiet");
});

test("update_status updates status BUT does NOT broadcast per-event (status_digest takes over)", async () => {
  // Per Yapsmith's revamp: per-event status_update messages are
  // dropped in favor of periodic batched status_digest sweeps.
  await call("login", { username: "alpha", project: "X", transient: false });
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const peerCursorBefore = ctx.chat!.takeMessages(peer.agent_id).messages.length;
  await call("update_status", { status: "deep work" });
  const taken = ctx.chat!.takeMessages(peer.agent_id);
  // No status_update system message in the peer's stream — the change
  // accumulated into the digest queue instead.
  expect(taken.messages.some((m) => m.system_kind === "status_update")).toBe(false);
  void peerCursorBefore;
  // Subscriber state DID update.
  expect(ctx.chat!.getByUsername("alpha")?.status).toBe("deep work");
});

test("update_status: 10-min topic cooldown rejects rapid re-updates without confirmed:true", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // First status set OK.
  const r1 = await call("update_status", { status: "Building auth" });
  expect(r1.ok).toBe(true);
  // Second change immediately after — should reject.
  const r2 = await call("update_status", { status: "Wrote login form" });
  expect(r2.ok).toBe(false);
  expect(r2.payload.error).toBe("topic_cooldown_active");
  expect(r2.payload.message).toContain("topic_cooldown_active");
  expect(r2.payload.previous_status).toBe("Building auth");
  expect(typeof r2.payload.cooldown_remaining_ms).toBe("number");
  // Subscriber state didn't change.
  expect(ctx.chat!.getByUsername("alpha")?.status).toBe("Building auth");
});

test("update_status: confirmed:true bypasses the cooldown for genuine topic shifts", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  await call("update_status", { status: "Building auth" });
  const r = await call("update_status", { status: "Reviewing infra", confirmed: true });
  expect(r.ok).toBe(true);
  expect(ctx.chat!.getByUsername("alpha")?.status).toBe("Reviewing infra");
});

test("update_status: idempotent calls (same status) bypass the cooldown", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  await call("update_status", { status: "Building auth" });
  const r = await call("update_status", { status: "Building auth" });
  expect(r.ok).toBe(true);
});

test("update_status: project/username-only changes (no status field) bypass the cooldown", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  await call("update_status", { status: "Building auth" });
  const r = await call("update_status", { project: "Y" });
  expect(r.ok).toBe(true);
  expect(ctx.chat!.getByUsername("alpha")?.project).toBe("Y");
});

test("status digest: sweepStatusDigest emits a per-recipient DM to non-dm/non-quiet peers", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // Peers: one in `all` mode, one in `project` mode, one in `dm`
  // mode (excluded), one in `quiet` mode (excluded).
  const allPeer = ctx.chat!.add({ username: "betauser", project: "X", transient: false, mode: "all" });
  const projectPeer = ctx.chat!.add({ username: "gammaer", project: "X", transient: false, mode: "project" });
  const dmPeer = ctx.chat!.add({ username: "deltauser", project: "X", transient: false, mode: "dm" });
  const quietPeer = ctx.chat!.add({ username: "epsiloner", project: "X", transient: false, mode: "quiet" });
  // Snapshot cursors so we only count digest messages.
  for (const p of [allPeer, projectPeer, dmPeer, quietPeer]) {
    ctx.chat!.takeMessages(p.agent_id);
  }
  // Trigger a status change.
  await call("update_status", { status: "deep work" });
  // Sweep.
  const dispatched = ctx.chat!.sweepStatusDigest();
  // 2 recipients (all + project); dm + quiet excluded.
  expect(dispatched).toBe(2);
  for (const p of [allPeer, projectPeer]) {
    const taken = ctx.chat!.takeMessages(p.agent_id);
    const digest = taken.messages.find((m) => m.system_kind === "status_digest");
    expect(digest).toBeDefined();
    expect(digest!.text).toContain("status_digest — 1 agent changed status");
    expect(digest!.text).toContain("alpha");
    expect(digest!.text).toContain("deep work");
    expect(digest!.scope).toBe("dm");
    expect(digest!.target).toBe(p.username);
  }
  // dm-mode + quiet-mode peers DID NOT get the digest in their stream.
  for (const p of [dmPeer, quietPeer]) {
    const taken = ctx.chat!.takeMessages(p.agent_id);
    expect(taken.messages.some((m) => m.system_kind === "status_digest")).toBe(false);
  }
});

test("status digest: empty changed-set is a no-op", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "betauser", project: "X", transient: false });
  expect(ctx.chat!.sweepStatusDigest()).toBe(0);
});

test("status digest: clears the changed-agent set so the next sweep doesn't re-emit", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "betauser", project: "X", transient: false });
  await call("update_status", { status: "deep work" });
  expect(ctx.chat!.sweepStatusDigest()).toBeGreaterThan(0);
  expect(ctx.chat!.sweepStatusDigest()).toBe(0); // already drained
});

test("send_message: 60-min staleness nudge surfaces in hints when status hasn't changed", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  // Force the subscriber's status_updated_at older than the threshold.
  const me = ctx.chat!.getByUsername("alpha")!;
  me.status_updated_at = Date.now() - (61 * 60 * 1000);
  const r = await call("send_message", { text: "hello", scope: "global" });
  expect(r.ok).toBe(true);
  const hints = (r.payload.hints as string[] | undefined) ?? [];
  expect(hints.length).toBe(1);
  expect(hints[0]).toContain("Status unchanged for");
  expect(hints[0]).toContain("TOPIC has shifted");
  expect(hints[0]).toContain("not for sub-tasks");
});

test("send_message: no staleness nudge when status is fresh", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_message", { text: "hello", scope: "global" });
  expect(r.payload.hints).toBeUndefined();
});

// --- §6 LOW status-with-metadata ---

test("update_status: meta { task, blocker, eta } persists on subscriber + surfaces in response + list_agents", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("update_status", {
    status: "Building auth",
    meta: { task: "wire login form", blocker: "design review pending", eta: "EOD" },
  });
  expect(r.ok).toBe(true);
  expect(r.payload.meta).toEqual({
    task: "wire login form",
    blocker: "design review pending",
    eta: "EOD",
  });
  // list_agents reflects it.
  const list = await call("list_agents");
  const me = (list.payload.agents as Array<{ username: string; status_meta?: unknown }>)
    .find((a) => a.username === "alpha");
  expect(me?.status_meta).toEqual({
    task: "wire login form",
    blocker: "design review pending",
    eta: "EOD",
  });
});

test("update_status: meta is partial — supplied fields update; others preserved", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  await call("update_status", {
    status: "Building auth",
    meta: { task: "wire login", blocker: "review", eta: "EOD" },
  });
  // Update only blocker; task + eta should survive.
  await call("update_status", { meta: { blocker: "unblocked" } });
  const list = await call("list_agents");
  const me = (list.payload.agents as Array<{ username: string; status_meta?: { task?: string; blocker?: string; eta?: string } }>)
    .find((a) => a.username === "alpha");
  expect(me?.status_meta).toEqual({
    task: "wire login",
    blocker: "unblocked",
    eta: "EOD",
  });
});

test("update_status: meta: null clears all metadata fields", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  await call("update_status", {
    status: "Building auth",
    meta: { task: "x", blocker: "y" },
  });
  const r = await call("update_status", { meta: null });
  expect(r.ok).toBe(true);
  expect(r.payload.meta).toBeUndefined();
});

// --- §6 HIGH profile_update broadcast ---

test("update_profile: emits system_kind:profile_update to project peers when description/expertise/owns/color change", async () => {
  // register caller + a peer in same project so the broadcast lands somewhere observable.
  const { createPersona } = await import("../../identity/index.ts");
  createPersona(ctx.paths, {
    username: "alpha",
    project: "X",
    cwd: "/work/alpha",
    platform: "linux",
    description: "lead", expertise: ["x"], owns: ["/work/alpha"],
  });
  await call("claim", { username: "alpha" });
  const peer = ctx.chat!.add({ username: "betauser", project: "X", transient: false });
  ctx.chat!.takeMessages(peer.agent_id); // drain initial
  // Profile field change → broadcast.
  const r = await call("update_profile", { description: "updated lead description" });
  expect(r.ok).toBe(true);
  const taken = ctx.chat!.takeMessages(peer.agent_id);
  const msg = taken.messages.find((m) => m.system_kind === "profile_update");
  expect(msg).toBeDefined();
  expect(msg!.text).toContain("alpha updated profile");
  expect(msg!.text).toContain("description");
  // Body should carry the NEW value, not just the field name — admins
  // shouldn't have to call list to learn what changed.
  expect(msg!.text).toContain("updated lead description");
});

test("update_profile: broadcast body renders new values for expertise/owns/color (not just field names)", async () => {
  const { createPersona } = await import("../../identity/index.ts");
  createPersona(ctx.paths, {
    username: "alpha",
    project: "X",
    cwd: "/work/alpha",
    platform: "linux",
    description: "lead", expertise: ["x"], owns: ["/work/alpha"],
  });
  await call("claim", { username: "alpha" });
  const peer = ctx.chat!.add({ username: "betauser", project: "X", transient: false });
  ctx.chat!.takeMessages(peer.agent_id);
  await call("update_profile", {
    expertise: ["typescript", "bun", "sqlite"],
    owns: ["/work/alpha", "/work/shared"],
    color: "red",
  });
  const taken = ctx.chat!.takeMessages(peer.agent_id);
  const msg = taken.messages.find((m) => m.system_kind === "profile_update");
  expect(msg).toBeDefined();
  expect(msg!.text).toContain("alpha updated profile:");
  expect(msg!.text).toContain("expertise: typescript, bun, sqlite");
  expect(msg!.text).toContain("owns: /work/alpha, /work/shared");
  expect(msg!.text).toContain("color: red");
});

test("update_profile: broadcast renders color clear as '(cleared)' when set to null", async () => {
  const { createPersona } = await import("../../identity/index.ts");
  createPersona(ctx.paths, {
    username: "alpha",
    project: "X",
    cwd: "/work/alpha",
    platform: "linux",
    description: "lead", expertise: ["x"], owns: ["/work/alpha"],
  });
  await call("claim", { username: "alpha" });
  const peer = ctx.chat!.add({ username: "betauser", project: "X", transient: false });
  ctx.chat!.takeMessages(peer.agent_id);
  await call("update_profile", { color: null });
  const taken = ctx.chat!.takeMessages(peer.agent_id);
  const msg = taken.messages.find((m) => m.system_kind === "profile_update");
  expect(msg).toBeDefined();
  expect(msg!.text).toContain("color: (cleared)");
});

test("update_profile: non-profile fields (mode, launch_args, channels) do NOT emit a broadcast", async () => {
  const { createPersona } = await import("../../identity/index.ts");
  createPersona(ctx.paths, {
    username: "alpha",
    project: "X",
    cwd: "/work/alpha",
    platform: "linux",
    description: "lead", expertise: ["x"], owns: ["/work/alpha"],
  });
  await call("claim", { username: "alpha" });
  const peer = ctx.chat!.add({ username: "betauser", project: "X", transient: false });
  ctx.chat!.takeMessages(peer.agent_id);
  await call("update_profile", { mode: "fresh", launch_args: ["--print"] });
  const taken = ctx.chat!.takeMessages(peer.agent_id);
  expect(taken.messages.some((m) => m.system_kind === "profile_update")).toBe(false);
});

// --- send_structured ---

test("send_structured persists kind + payload, delivers to project peers", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  const r = await call("send_structured", {
    kind: "pushback",
    payload: { pattern: 14, evidence: { file: "a.ts", line: 89 } },
    text: "pushback on a.ts:89",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.kind).toBe("pushback");
  expect(typeof r.payload.message_id).toBe("string");

  const taken = ctx.chat!.takeMessages(peer.agent_id);
  const found = taken.messages.find((m) => m.user_kind === "pushback");
  expect(found).toBeTruthy();
  expect(found?.text).toBe("pushback on a.ts:89");
  expect(found?.payload).toEqual({ pattern: 14, evidence: { file: "a.ts", line: 89 } });
});

test("send_structured: text defaults to [kind] when omitted", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const peer = ctx.chat!.add({ username: "beta", project: "X", transient: false });
  await call("send_structured", { kind: "claim", payload: { x: 1 } });
  const taken = ctx.chat!.takeMessages(peer.agent_id);
  expect(taken.messages.find((m) => m.user_kind === "claim")?.text).toBe("[claim]");
});

test("send_structured: missing payload errors at dispatch (invalid_args from required-field check)", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_structured", { kind: "x" });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_args");
  const pathErrors = r.payload.path_errors as Array<{ path: string; message: string }>;
  expect(pathErrors.some((e) => e.path === "/payload")).toBe(true);
});

test("send_structured: empty kind errors", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_structured", { kind: "   ", payload: {} });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("invalid_kind");
});

test("send_structured: reserved system kinds rejected", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_structured", { kind: "join", payload: { x: 1 } });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("reserved_kind");
});

test("send_structured: payload over 64 KB rejected", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const big = "x".repeat(65 * 1024);
  const r = await call("send_structured", { kind: "blob", payload: { data: big } });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("payload_too_large");
});

test("send_structured: DM to offline target fails recipient_offline", async () => {
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_structured", {
    kind: "claim",
    payload: { x: 1 },
    scope: "dm",
    target: "ghost",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("recipient_offline");
});

test("send_structured: payload round-trips via get_message", async () => {
  // Wire a db-backed router so persistence happens through the normal
  // path (not the manual insert the get_message test uses for plain
  // text messages — we want to verify user_kind+payload survive the
  // real persistMessage→queryMessage round-trip).
  const { openChatDb } = await import("../../storage/index.ts");
  const db = openChatDb(ctx.paths.chatDbPath);
  ctx.chat = new ChatRouter({ paths: ctx.paths, db });
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat.add({ username: "beta", project: "X", transient: false });
  const sent = await call("send_structured", {
    kind: "evidence_cite",
    payload: { file: "x.ts", lines: [10, 20], severity: "high" },
    text: "see citation",
  });
  expect(sent.ok).toBe(true);
  const fetched = await call("get_message", {
    message_id: sent.payload.message_id as string,
  });
  expect(fetched.ok).toBe(true);
  expect(fetched.payload.user_kind).toBe("evidence_cite");
  expect(fetched.payload.payload).toEqual({
    file: "x.ts",
    lines: [10, 20],
    severity: "high",
  });
  expect(fetched.payload.text).toBe("see citation");
  db.close();
});

test("send_structured: unknown schema_id errors with schema_not_found", async () => {
  useDbBackedRouter();
  await call("login", { username: "alpha", project: "X", transient: false });
  const r = await call("send_structured", {
    kind: "pushback",
    payload: { pattern: 14 },
    schema_id: "ghost/notregistered@v1",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("schema_not_found");
});

test("send_structured: registered schema validates payload + sets schema_validated:true", async () => {
  useDbBackedRouter();
  await call("login", { username: "alpha", project: "X", transient: false });
  ctx.chat!.add({ username: "beta", project: "X", transient: false });
  await call("register_schema", {
    schema_id: "test/pushback@v1",
    schema: {
      type: "object",
      required: ["pattern", "evidence"],
      properties: {
        pattern: { type: "integer" },
        evidence: {
          type: "object",
          required: ["file", "line"],
          properties: {
            file: { type: "string" },
            line: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    description: "Pushback against a gaming pattern with evidence.",
  });
  const r = await call("send_structured", {
    kind: "pushback",
    payload: { pattern: 14, evidence: { file: "a.ts", line: 89 } },
    schema_id: "test/pushback@v1",
  });
  expect(r.ok).toBe(true);
  expect(r.payload.schema_id).toBe("test/pushback@v1");
  expect(r.payload.schema_validated).toBe(true);
});

// --- resume_summary on login ---

test("login: claimed-persona response includes resume_summary with memory facets", async () => {
  const { createPersona } = await import("../../identity/index.ts");
  const { appendEntry } = await import("../../memory/index.ts");
  createPersona(ctx.paths, {
    username: "alpha",
    project: "X",
    cwd: "/work/alpha",
    platform: "linux",
    description: "lead",
    expertise: [],
    owns: ["/work/alpha"],
  });
  appendEntry(ctx.paths, "alpha", { summary: "decision-1", text: "x", kind: "decision" });
  appendEntry(ctx.paths, "alpha", { summary: "retraction-1", text: "x", kind: "retraction" });
  appendEntry(ctx.paths, "alpha", { summary: "loose", text: "x" });
  await call("claim", { username: "alpha" });
  const r = await call("login", {
    username: "alpha",
    project: "X",
    transient: false,
    status: "scoping",
  });
  expect(r.ok).toBe(true);
  const summary = r.payload.resume_summary as Record<string, unknown>;
  expect(summary).toBeTruthy();
  expect(summary.active_memory_count).toBe(3);
  expect(summary.memory_by_kind).toEqual({
    decision: 1,
    retraction: 1,
    _unspecified: 1,
  });
  expect(summary.last_status).toBe("scoping");
  expect((summary.recent_memory as unknown[]).length).toBeGreaterThan(0);
});

test("login: guest (transient) response has no resume_summary", async () => {
  const r = await call("login", {
    username: "guest1",
    project: "X",
    transient: true,
  });
  expect(r.ok).toBe(true);
  expect(r.payload.resume_summary).toBeUndefined();
});

test("send_structured: payload failing schema is rejected", async () => {
  useDbBackedRouter();
  await call("login", { username: "alpha", project: "X", transient: false });
  await call("register_schema", {
    schema_id: "test/pushback@v1",
    schema: {
      type: "object",
      required: ["pattern", "evidence"],
      properties: {
        pattern: { type: "integer" },
        evidence: { type: "object", required: ["file"] },
      },
    },
  });
  const r = await call("send_structured", {
    kind: "pushback",
    payload: { pattern: "not-an-int" },
    schema_id: "test/pushback@v1",
  });
  expect(r.ok).toBe(false);
  expect(r.payload.error).toBe("schema_validation_failed");
});

// --- statusline sidecar (CC-session-keyed file the prompt bar cats) ---

function readSidecar(c: HandlerContext, sid: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(statuslineSidecarPath(c.paths, sid), "utf8"));
}

test("login writes the statusline sidecar keyed by claude_session_id", async () => {
  const sid = "26ec40d3-d750-42f3-9b24-6f4d83c179b2";
  const c = createContext({
    paths: ctx.paths,
    session: new Session("sl-login"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
    claude_session_id: sid,
  });
  await dispatch(
    "login",
    { username: "slalice", project: "ops", transient: true, status: "exploring" },
    c,
  );
  expect(readSidecar(c, sid)).toEqual({
    persona: "slalice",
    chat: "slalice",
    status: "exploring",
  });
});

test("update_status refreshes the sidecar status field", async () => {
  const sid = "11111111-2222-3333-4444-555555555555";
  const c = createContext({
    paths: ctx.paths,
    session: new Session("sl-status"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
    claude_session_id: sid,
  });
  await dispatch(
    "login",
    { username: "slbob", project: "ops", transient: true, status: "first" },
    c,
  );
  await dispatch("update_status", { status: "second", confirmed: true }, c);
  const parsed = readSidecar(c, sid);
  expect(parsed.status).toBe("second");
  expect(parsed.chat).toBe("slbob");
});

test("logout removes the sidecar", async () => {
  const sid = "99999999-8888-7777-6666-555555555555";
  const c = createContext({
    paths: ctx.paths,
    session: new Session("sl-logout"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
    claude_session_id: sid,
  });
  await dispatch(
    "login",
    { username: "slcarol", project: "ops", transient: true, status: "up" },
    c,
  );
  expect(fs.existsSync(statuslineSidecarPath(c.paths, sid))).toBe(true);
  await dispatch("logout", {}, c);
  expect(fs.existsSync(statuslineSidecarPath(c.paths, sid))).toBe(false);
});

test("login without a claude_session_id skips the sidecar (no crash)", async () => {
  const c = createContext({
    paths: ctx.paths,
    session: new Session("sl-nosid"),
    watchdog: ctx.watchdog,
    parent_pid: ctx.parent_pid,
    platform: ctx.platform,
    chat: ctx.chat,
    // claude_session_id omitted -> null
  });
  const r = await dispatch(
    "login",
    { username: "sldave", project: "ops", transient: true, status: "up" },
    c,
  );
  expect(r.isError).toBeFalsy();
});
