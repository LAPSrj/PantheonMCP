import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  IdentityError,
  validateUsername,
  createPersona,
  readPersona,
  listPersonas,
  patchPersona,
  deletePersona,
  prefixCollision,
  personasForCwd,
  stampSummoned,
} from "../index.ts";
import type { PersonaCreate } from "../types.ts";

let tmpDir: string;
let paths: Paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-registry-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureInput(over: Partial<PersonaCreate> = {}): PersonaCreate {
  return {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/repos/pantheon",
    platform: "linux",
    description: "lead implementer",
    expertise: ["typescript", "mcp"],
    owns: ["/repos/pantheon"],
    ...over,
  };
}

test("validateUsername rejects empty / whitespace / too-long names", () => {
  expect(() => validateUsername("")).toThrow(IdentityError);
  expect(() => validateUsername("has space")).toThrow(IdentityError);
  expect(() => validateUsername("-leadingdash")).toThrow(IdentityError);
  const long = "a".repeat(49);
  expect(() => validateUsername(long)).toThrow(IdentityError);
});

test("validateUsername rejects reserved system names", () => {
  for (const r of ["admin", "system", "pantheon", "Admin"]) {
    let err: unknown;
    try {
      validateUsername(r);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as IdentityError).code).toBe("reserved_username");
  }
});

test("validateUsername rejects digit-suffix (incarnation rule)", () => {
  for (const u of ["swoopfinch2", "agent1", "yapsmith42"]) {
    let err: unknown;
    try {
      validateUsername(u);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as IdentityError).code).toBe("digit_suffix_reserved");
  }
});

test("validateUsername accepts canonical handles", () => {
  for (const u of ["vellumpike", "yap_smith", "moth-whistle", "x"]) {
    expect(() => validateUsername(u)).not.toThrow();
  }
});

test("createPersona persists a new entry with server-managed defaults", () => {
  const before = Date.now();
  const persona = createPersona(paths, fixtureInput());
  const after = Date.now();

  expect(persona.username).toBe("vellumpike");
  expect(persona.last_summoned_at).toBeNull();
  expect(persona.last_rested_at).toBeNull();
  expect(persona.summon_count).toBe(0);
  expect(persona.provisional).toBe(false);
  expect(persona.mode).toBe("fresh");
  expect(persona.color).toBeNull();
  expect(persona.registered_at).toBeGreaterThanOrEqual(before);
  expect(persona.registered_at).toBeLessThanOrEqual(after);

  expect(readPersona(paths, "vellumpike")).toEqual(persona);
});

test("createPersona is idempotent for same (username, cwd)", () => {
  const a = createPersona(paths, fixtureInput({ description: "v1" }));
  const b = createPersona(paths, fixtureInput({ description: "v2" }));
  expect(b.description).toBe("v2");
  expect(b.registered_at).toBe(a.registered_at);
});

test("createPersona errors username_taken_other_cwd without force", () => {
  createPersona(paths, fixtureInput({ cwd: "/a" }));
  let err: unknown;
  try {
    createPersona(paths, fixtureInput({ cwd: "/b" }));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("username_taken_other_cwd");
  expect((err as IdentityError).extra.registered_cwd).toBe("/a");
});

test("createPersona with force overwrites a different-cwd entry", () => {
  createPersona(paths, fixtureInput({ cwd: "/a" }));
  const replaced = createPersona(paths, fixtureInput({ cwd: "/b" }), { force: true });
  expect(replaced.cwd).toBe("/b");
});

test("createPersona errors prefix_collision against another persona", () => {
  createPersona(paths, fixtureInput({ username: "vellum" }));
  let err: unknown;
  try {
    createPersona(paths, fixtureInput({ username: "vellumpike", cwd: "/other" }));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("username_prefix_collision");
  expect((err as IdentityError).extra.collides_with).toBe("vellum");
});

test("prefixCollision uses 3-4 char window and is case-insensitive", () => {
  createPersona(paths, fixtureInput({ username: "Yapsmith" }));
  expect(prefixCollision(paths, "yapster")).toBe("Yapsmith");
  expect(prefixCollision(paths, "yap")).toBe("Yapsmith");
  expect(prefixCollision(paths, "ya")).toBeNull();
  expect(prefixCollision(paths, "zephyr")).toBeNull();
});

test("prefixCollision skips ignoreSelf", () => {
  createPersona(paths, fixtureInput({ username: "vellumpike" }));
  expect(prefixCollision(paths, "vellumpike", "vellumpike")).toBeNull();
});

test("listPersonas returns every entry; missing dir returns empty", () => {
  expect(listPersonas(paths)).toEqual([]);
  createPersona(paths, fixtureInput({ username: "vellumpike", cwd: "/a" }));
  createPersona(paths, fixtureInput({ username: "moth-whistle", cwd: "/b" }));
  const all = listPersonas(paths).map((p) => p.username).sort();
  expect(all).toEqual(["moth-whistle", "vellumpike"]);
});

test("listPersonas skips unparseable JSON files instead of throwing", () => {
  createPersona(paths, fixtureInput({ username: "vellumpike" }));
  fs.writeFileSync(path.join(paths.personasDir, "broken.json"), "{not-json");
  const all = listPersonas(paths).map((p) => p.username);
  expect(all).toEqual(["vellumpike"]);
});

test("patchPersona updates whitelisted fields, preserves the rest", () => {
  createPersona(paths, fixtureInput());
  const updated = patchPersona(paths, "vellumpike", {
    description: "lead implementer of pantheon",
    color: "purple",
  });
  expect(updated.description).toBe("lead implementer of pantheon");
  expect(updated.color).toBe("purple");
  expect(updated.expertise).toEqual(["typescript", "mcp"]);
});

test("patchPersona throws not_registered when no entry exists", () => {
  let err: unknown;
  try {
    patchPersona(paths, "ghost", { description: "x" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("not_registered");
});

test("deletePersona returns false when entry never existed", () => {
  expect(deletePersona(paths, "ghost")).toBe(false);
});

test("deletePersona with dropMemory removes the memory file too", () => {
  createPersona(paths, fixtureInput());
  // Seed a memory file.
  const memPath = path.join(paths.personasDir, "vellumpike", "memory.json");
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, "{}");

  expect(deletePersona(paths, "vellumpike", { dropMemory: true })).toBe(true);
  expect(readPersona(paths, "vellumpike")).toBeNull();
  expect(fs.existsSync(memPath)).toBe(false);
});

test("deletePersona without dropMemory leaves memory in place", () => {
  createPersona(paths, fixtureInput());
  const memPath = path.join(paths.personasDir, "vellumpike", "memory.json");
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, "{}");

  deletePersona(paths, "vellumpike");
  expect(fs.existsSync(memPath)).toBe(true);
});

test("personasForCwd filters by cwd", () => {
  createPersona(paths, fixtureInput({ username: "vellumpike", cwd: "/a" }));
  createPersona(paths, fixtureInput({ username: "moth-whistle", cwd: "/b" }));
  const a = personasForCwd(paths, "/a").map((p) => p.username);
  expect(a).toEqual(["vellumpike"]);
});

test("stampSummoned increments summon_count + last_summoned_at", () => {
  createPersona(paths, fixtureInput());
  stampSummoned(paths, "vellumpike");
  const after = readPersona(paths, "vellumpike");
  expect(after?.summon_count).toBe(1);
  expect(after?.last_summoned_at).not.toBeNull();
});
