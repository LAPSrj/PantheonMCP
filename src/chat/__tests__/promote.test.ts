import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { createPersona, readPersona } from "../../identity/index.ts";
import { ChatError, ChatRouter, promoteInPlace } from "../index.ts";

let tmpDir: string;
let paths: Paths;
let router: ChatRouter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-promote-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  router = new ChatRouter({ paths });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("promoteInPlace flips guest → claimed_persona", () => {
  const guest = router.add({ username: "alice", project: "ops", transient: true });
  const persona = promoteInPlace({
    paths,
    router,
    agent_id: guest.agent_id,
    fields: {
      project: "ops",
      description: "ops human",
      expertise: ["bash"],
      owns: ["/ops"],
    },
    default_cwd: "/ops",
    platform: "linux",
  });
  expect(persona.username).toBe("alice");
  expect(persona.project).toBe("ops");
  // Subscriber's transient flag flipped.
  expect(router.getByAgentId(guest.agent_id)?.transient).toBe(false);
  expect(router.getByAgentId(guest.agent_id)?.promoted_at).not.toBeNull();
  // Registry now has the persona.
  expect(readPersona(paths, "alice")).not.toBeNull();
});

test("promoteInPlace errors not_a_guest for an already-non-transient subscriber", () => {
  // Subscriber that's NOT a guest (e.g. a persona that logged into
  // chat after claiming). promote requires `transient: true`.
  const sub = router.add({ username: "vellumpike", project: "pantheon", transient: false });
  let err: unknown;
  try {
    promoteInPlace({
      paths,
      router,
      agent_id: sub.agent_id,
      fields: {
        project: "pantheon",
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
  expect((err as ChatError).code).toBe("not_a_guest");
});

test("promoteInPlace errors promote_validation_failed when fields incomplete", () => {
  const guest = router.add({ username: "alice", project: "ops", transient: true });
  let err: unknown;
  try {
    promoteInPlace({
      paths,
      router,
      agent_id: guest.agent_id,
      fields: { project: "ops", description: "", expertise: [], owns: [] },
      default_cwd: "/ops",
      platform: "linux",
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ChatError);
  expect((err as ChatError).code).toBe("promote_validation_failed");
});

test("promoteInPlace race-loss → already_registered; guest stays guest", () => {
  // Guest joins first (no persona exists yet, so no prefix collision).
  const guest = router.add({ username: "vellumpik", project: "p", transient: true });
  // Then a sibling-process race: a colliding-prefix persona registers
  // before this guest's promote runs.
  createPersona(paths, {
    username: "vellumpike",
    project: "p",
    cwd: "/elsewhere",
    platform: "linux",
  });
  let err: unknown;
  try {
    promoteInPlace({
      paths,
      router,
      agent_id: guest.agent_id,
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
  expect((err as ChatError).code).toBe("already_registered");
  // Guest stays a guest.
  expect(router.getByAgentId(guest.agent_id)?.transient).toBe(true);
});
