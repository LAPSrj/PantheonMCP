import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  IdentityError,
  Session,
  createPersona,
  transitionBecome,
  transitionClaim,
  transitionLoginGuest,
  transitionManifest,
  transitionPromote,
  transitionRegister,
  transitionRestEnter,
  transitionRestExit,
  transitionUnregister,
} from "../index.ts";
import type { PersonaCreate } from "../types.ts";

let tmpDir: string;
let paths: Paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-trans-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function input(over: Partial<PersonaCreate> = {}): PersonaCreate {
  return {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/repos/pantheon",
    platform: "linux",
    description: "lead implementer",
    expertise: ["typescript"],
    owns: ["/repos/pantheon"],
    ...over,
  };
}

// --- claim / manifest ---

test("transitionClaim flips unclaimed → claimed_persona on a registered handle", () => {
  createPersona(paths, input());
  const session = new Session("s-1");
  const persona = transitionClaim(paths, session, "vellumpike");
  expect(persona.username).toBe("vellumpike");
  expect(session.claimedUsername).toBe("vellumpike");
});

test("transitionClaim throws not_registered and leaves session unchanged", () => {
  const session = new Session("s-1");
  let err: unknown;
  try {
    transitionClaim(paths, session, "ghost");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("not_registered");
  expect(session.state.kind).toBe("unclaimed");
});

test("transitionManifest auto-claims on a sole cwd match", () => {
  createPersona(paths, input({ cwd: "/work" }));
  const session = new Session("s-1");
  const result = transitionManifest(paths, session, "/work");
  expect("matched" in result).toBe(true);
  if ("matched" in result) {
    expect(result.matched.reason).toBe("sole-match");
  }
  expect(session.claimedUsername).toBe("vellumpike");
});

test("transitionManifest returns ambiguous when multiple match without hint", () => {
  createPersona(paths, input({ username: "vellumpike", cwd: "/work" }));
  createPersona(paths, input({ username: "moth-whistle", cwd: "/work" }));
  const session = new Session("s-1");
  const result = transitionManifest(paths, session, "/work");
  expect("ambiguous" in result).toBe(true);
  expect(session.state.kind).toBe("unclaimed");
});

test("transitionManifest disambiguates with a hint matching one persona", () => {
  createPersona(paths, input({ username: "vellumpike", cwd: "/work", expertise: ["pantheon"] }));
  createPersona(paths, input({ username: "moth-whistle", cwd: "/work", expertise: ["chat"] }));
  const session = new Session("s-1");
  const result = transitionManifest(paths, session, "/work", "chat");
  if (!("matched" in result)) throw new Error("expected match");
  expect(result.matched.persona.username).toBe("moth-whistle");
  expect(result.matched.reason).toBe("hint-match");
});

test("transitionManifest returns none when no persona owns the cwd", () => {
  const session = new Session("s-1");
  const result = transitionManifest(paths, session, "/empty");
  expect(result).toEqual({ none: true });
});

// --- register: identity-leak fix (§13) ---

test("transitionRegister default claim_after=false leaves session claim untouched", () => {
  createPersona(paths, input({ username: "self", cwd: "/self" }));
  const session = new Session("s-1");
  transitionClaim(paths, session, "self");
  expect(session.claimedUsername).toBe("self");

  const result = transitionRegister(
    paths,
    session,
    input({ username: "other", cwd: "/other" }),
  );
  expect(result.claimed).toBe(false);
  expect(session.claimedUsername).toBe("self");
  expect(result.note).toContain("'other'");
  expect(result.note).toContain("'self'");
  expect(result.note).toMatch(/call claim\(\) to switch/);
});

test("transitionRegister with claim_after=true flips session to the new handle", () => {
  const session = new Session("s-1");
  const result = transitionRegister(paths, session, input(), { claim_after: true });
  expect(result.claimed).toBe(true);
  expect(session.claimedUsername).toBe(result.persona.username);
});

test("transitionRegister force+claim_after replaces a different-cwd registration AND flips session", () => {
  createPersona(paths, input({ username: "vellumpike", cwd: "/old" }));
  const session = new Session("s-1");
  const result = transitionRegister(
    paths,
    session,
    input({ username: "vellumpike", cwd: "/new" }),
    { force: true, claim_after: true },
  );
  expect(result.persona.cwd).toBe("/new");
  expect(session.claimedUsername).toBe("vellumpike");
});

// --- become ---

test("transitionBecome flips claimed_persona to a different registered persona", () => {
  createPersona(paths, input({ username: "vellumpike", cwd: "/a" }));
  createPersona(paths, input({ username: "moth-whistle", cwd: "/b" }));
  const session = new Session("s-1");
  transitionClaim(paths, session, "vellumpike");
  transitionBecome(paths, session, "moth-whistle");
  expect(session.claimedUsername).toBe("moth-whistle");
});

test("transitionBecome on an unregistered handle errors AND leaves session unchanged (doc-silent default)", () => {
  createPersona(paths, input({ username: "vellumpike" }));
  const session = new Session("s-1");
  transitionClaim(paths, session, "vellumpike");

  let err: unknown;
  try {
    transitionBecome(paths, session, "ghost");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("not_registered");
  expect(session.claimedUsername).toBe("vellumpike");
});

test("transitionBecome from unclaimed errors with no_persona", () => {
  const session = new Session("s-1");
  let err: unknown;
  try {
    transitionBecome(paths, session, "vellumpike");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("no_persona");
});

// --- unregister ---

test("transitionUnregister deletes registry entry FIRST, then clears claim", () => {
  createPersona(paths, input());
  const session = new Session("s-1");
  transitionClaim(paths, session, "vellumpike");

  // Seed a memory file to verify keep_memory semantics.
  const memPath = path.join(paths.personasDir, "vellumpike", "memory.json");
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, '{"version":1,"entries":[]}');

  const result = transitionUnregister(paths, session, { keep_memory: true });
  expect(result.unregistered).toBe("vellumpike");
  expect(session.state.kind).toBe("unclaimed");
  expect(fs.existsSync(memPath)).toBe(true);
});

// --- guest + promote ---

test("transitionLoginGuest succeeds when handle is not a registered persona", () => {
  const session = new Session("s-1");
  transitionLoginGuest(paths, session, "alice");
  expect(session.state.kind).toBe("guest");
  expect(session.guestUsername).toBe("alice");
});

test("transitionLoginGuest rejects a handle that is a registered persona", () => {
  createPersona(paths, input({ username: "vellumpike" }));
  const session = new Session("s-1");
  let err: unknown;
  try {
    transitionLoginGuest(paths, session, "vellumpike");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("already_registered");
});

test("transitionPromote flips guest → claimed_persona on success", () => {
  const session = new Session("s-1");
  transitionLoginGuest(paths, session, "moth-whistle");
  const persona = transitionPromote(
    paths,
    session,
    input({ username: "moth-whistle", cwd: "/repos/chat" }),
  );
  expect(persona.username).toBe("moth-whistle");
  expect(session.claimedUsername).toBe("moth-whistle");
});

test("transitionPromote requires the promote handle to match the guest handle", () => {
  const session = new Session("s-1");
  transitionLoginGuest(paths, session, "alice");
  let err: unknown;
  try {
    transitionPromote(paths, session, input({ username: "vellumpike" }));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("invalid_username");
  expect(session.guestUsername).toBe("alice");
});

test("transitionPromote translates collision to already_registered; guest stays guest", () => {
  // Race-loss simulation: another writer pre-empts with a colliding-prefix
  // persona before promote tries.
  createPersona(paths, input({ username: "vellumpike" }));
  const session = new Session("s-1");
  transitionLoginGuest(paths, session, "vellumpik"); // not yet a persona but prefix-collides

  let err: unknown;
  try {
    transitionPromote(
      paths,
      session,
      input({ username: "vellumpik", cwd: "/elsewhere" }),
    );
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("already_registered");
  expect(session.state.kind).toBe("guest");
  expect(session.guestUsername).toBe("vellumpik");
});

// --- rest ---

test("transitionRestEnter sets resting flag without changing claim", () => {
  createPersona(paths, input());
  const session = new Session("s-1");
  transitionClaim(paths, session, "vellumpike");
  transitionRestEnter(session);
  expect(session.isResting).toBe(true);
  expect(session.claimedUsername).toBe("vellumpike");
});

test("transitionRestExit is a no-op when not resting", () => {
  createPersona(paths, input());
  const session = new Session("s-1");
  transitionClaim(paths, session, "vellumpike");
  transitionRestExit(session);
  expect(session.isResting).toBe(false);
});

test("transitionRestEnter from unclaimed errors with no_persona", () => {
  const session = new Session("s-1");
  let err: unknown;
  try {
    transitionRestEnter(session);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("no_persona");
});
