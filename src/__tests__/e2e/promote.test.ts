import { test, expect, beforeEach, afterEach } from "bun:test";
import { call, makeFixture, type E2EFixture } from "./harness.ts";

let fix: E2EFixture;

beforeEach(() => {
  fix = makeFixture();
});

afterEach(() => {
  fix.cleanup();
});

test("promote-in-place: guest joins, promotes, agent_id preserved, broadcast fires", async () => {
  // Process A logs in as a guest.
  const guestLogin = await call(fix.procA, "login", {
    username: "leandro",
    project: "ops",
    transient: true,
  });
  expect(guestLogin.ok).toBe(true);
  expect(guestLogin.payload.transient).toBe(true);
  const initialAgentId = guestLogin.payload.agent_id as string;

  // Verify cross-process visibility (procB sees the guest before promote).
  const beforeList = await call(fix.procB, "list_agents");
  const before = (beforeList.payload.agents as Array<{ username: string; transient: boolean }>);
  expect(before.find((a) => a.username === "leandro")?.transient).toBe(true);

  // Procedure: from procA, call login again with `promote` (current
  // session is already a guest; the handler routes through promoteInPlace).
  // Note: today's login handler calls router.add() which would collide
  // since "leandro" is already taken by procA's own subscriber. To
  // exercise promoteInPlace directly, call the lower-level function.
  const { promoteInPlace, ChatError } = await import("../../chat/index.ts");
  const persona = promoteInPlace({
    paths: fix.paths,
    router: fix.procA.ctx.chat!,
    agent_id: initialAgentId,
    fields: {
      project: "ops",
      description: "ops human",
      expertise: ["bash"],
      owns: ["/ops"],
    },
    default_cwd: "/ops",
    platform: "linux",
  });
  expect(persona.username).toBe("leandro");

  // agent_id is preserved on the chat side.
  const sub = fix.procA.ctx.chat!.getByAgentId(initialAgentId);
  expect(sub?.agent_id).toBe(initialAgentId);
  expect(sub?.transient).toBe(false);
  expect(sub?.promoted_at).not.toBeNull();

  // Cross-process: procB's list_agents now sees leandro as non-transient.
  const afterList = await call(fix.procB, "list_agents");
  const after = (afterList.payload.agents as Array<{ username: string; transient: boolean }>);
  expect(after.find((a) => a.username === "leandro")?.transient).toBe(false);

  // The promotion broadcast lands in chat.db — both routers can observe
  // via takeMessages on a peer. Add a peer in procB and check.
  const peer = fix.procB.ctx.chat!.add({
    username: "watcher",
    project: "ops",
    transient: false,
  });
  // Don't call this — re-running the test surfaces no double-promotion.
  // Just confirm the promotion message exists in the chat history.
  const { queryMessages } = await import("../../chat/index.ts");
  const msgs = queryMessages(fix.procB.db, { scope: "project" });
  expect(msgs.some((m) => m.kind === "promotion")).toBe(true);

  // Verify we can route around: persona "leandro" can now be ask'd
  // (guests can't be ask targets; personas can — except across
  // routers, see harness comment about pendingAsks). Skip cross-router
  // ask here; just verify cross-process presence.
  void ChatError;
  void peer;
});

test("promote race-loss: another writer wins; guest stays guest", async () => {
  // Guest joins as "vellumpik" — no persona collision yet.
  const guestLogin = await call(fix.procA, "login", {
    username: "vellumpik",
    project: "p",
    transient: true,
  });
  expect(guestLogin.ok).toBe(true);

  // Another process registers a colliding-prefix persona before
  // procA's guest promotes.
  await call(fix.procB, "register", {
    username: "vellumpike",
    project: "p",
    cwd: "/elsewhere",
  });

  // procA's promote should fail with already_registered (translated
  // from createPersona's prefix-collision).
  const { promoteInPlace, ChatError } = await import("../../chat/index.ts");
  let err: unknown;
  try {
    promoteInPlace({
      paths: fix.paths,
      router: fix.procA.ctx.chat!,
      agent_id: guestLogin.payload.agent_id as string,
      fields: {
        project: "p",
        description: "x",
        expertise: ["x"],
        owns: ["x"],
      },
      default_cwd: "/work",
      platform: "linux",
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ChatError);
  expect((err as InstanceType<typeof ChatError>).code).toBe("already_registered");
  // Guest stays a guest.
  const sub = fix.procA.ctx.chat!.getByAgentId(guestLogin.payload.agent_id as string);
  expect(sub?.transient).toBe(true);
});
