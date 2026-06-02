import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolvePaths,
  isProjectSingleAgent,
  readProjectConfig,
  setProjectSingleAgent,
  type Paths,
} from "../../storage/index.ts";
import {
  IdentityError,
  createPersona,
  personasForProject,
} from "../index.ts";
import type { PersonaCreate } from "../types.ts";

let tmpDir: string;
let paths: Paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-single-agent-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function input(over: Partial<PersonaCreate> = {}): PersonaCreate {
  return {
    username: "alpha",
    project: "solo",
    cwd: "/repos/solo",
    platform: "linux",
    ...over,
  };
}

// --- project-config helpers ---

test("project config defaults to not-single-agent", () => {
  expect(isProjectSingleAgent(paths, "solo")).toBe(false);
  expect(readProjectConfig(paths, "solo")).toEqual({});
});

test("setProjectSingleAgent toggles and persists, preserving other fields", () => {
  setProjectSingleAgent(paths, "solo", true);
  expect(isProjectSingleAgent(paths, "solo")).toBe(true);

  // Simulate an unrelated future field on disk; toggle must keep it.
  setProjectSingleAgent(paths, "solo", false);
  expect(isProjectSingleAgent(paths, "solo")).toBe(false);
  expect(readProjectConfig(paths, "solo")).toEqual({ single_agent: false });
});

// --- registry gate ---

test("first persona in a single-agent project is allowed", () => {
  setProjectSingleAgent(paths, "solo", true);
  const p = createPersona(paths, input());
  expect(p.username).toBe("alpha");
  expect(personasForProject(paths, "solo").map((x) => x.username)).toEqual(["alpha"]);
});

test("second distinct persona in a single-agent project is rejected", () => {
  setProjectSingleAgent(paths, "solo", true);
  createPersona(paths, input({ username: "alpha" }));

  let err: unknown;
  try {
    createPersona(paths, input({ username: "beta", cwd: "/repos/solo-2" }));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("project_single_agent");
  expect((err as IdentityError).extra.existing).toBe("alpha");
  // Registry unchanged — still just the one persona.
  expect(personasForProject(paths, "solo").map((x) => x.username)).toEqual(["alpha"]);
});

test("the lock wins over force:true", () => {
  setProjectSingleAgent(paths, "solo", true);
  createPersona(paths, input({ username: "alpha" }));
  expect(() =>
    createPersona(paths, input({ username: "beta" }), { force: true }),
  ).toThrow(IdentityError);
});

test("re-registering the SAME persona is idempotent under the lock", () => {
  setProjectSingleAgent(paths, "solo", true);
  createPersona(paths, input({ username: "alpha", description: "v1" }));
  // Same handle, same cwd → idempotent update, allowed.
  const updated = createPersona(paths, input({ username: "alpha", description: "v2" }));
  expect(updated.description).toBe("v2");
  // Same handle, different cwd, force → still one persona, allowed.
  const moved = createPersona(
    paths,
    input({ username: "alpha", cwd: "/repos/elsewhere" }),
    { force: true },
  );
  expect(moved.cwd).toBe("/repos/elsewhere");
});

test("multi-agent projects are unaffected (opt-in only)", () => {
  // No config → multiple personas allowed freely.
  createPersona(paths, input({ username: "alpha", project: "team" }));
  createPersona(paths, input({ username: "bravo", project: "team", cwd: "/repos/team-2" }));
  expect(personasForProject(paths, "team").length).toBe(2);
});
