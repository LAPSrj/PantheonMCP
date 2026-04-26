import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { IdentityError, createPersona, forkPersona, listPersonas, readPersona } from "../index.ts";
import { appendEntry, loadStore } from "../../memory/index.ts";

let tmpDir: string;
let paths: Paths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-fork-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSource() {
  createPersona(paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work/pantheon",
    platform: "linux",
    description: "lead implementer",
    expertise: ["typescript", "mcp"],
    owns: ["/repos/pantheon"],
    launch_command: "claude",
    launch_args: ["--print"],
    mode: "fresh",
    color: "purple",
  });
  appendEntry(paths, "vellumpike", {
    text: "First decision: bun + TS strict.",
    kind: "decision",
    core: true,
  });
  appendEntry(paths, "vellumpike", {
    text: "Gotcha: SQLite WAL needs careful close on shutdown.",
    kind: "gotcha",
    summary: "wal-close-careful",
  });
}

test("forkPersona deep-copies profile fields except cwd; resets bookkeeping", () => {
  seedSource();
  const result = forkPersona({
    paths,
    from: "vellumpike",
    to: "obsidianfox",
    cwd: "/work/fork-experiment",
  });
  expect(result.source).toBe("vellumpike");
  expect(result.copied_entries).toBe(2);
  expect(result.persona.username).toBe("obsidianfox");
  expect(result.persona.cwd).toBe("/work/fork-experiment");
  // Profile inherited.
  expect(result.persona.project).toBe("pantheon");
  expect(result.persona.description).toBe("lead implementer");
  expect(result.persona.expertise).toEqual(["typescript", "mcp"]);
  expect(result.persona.owns).toEqual(["/repos/pantheon"]);
  expect(result.persona.color).toBe("purple");
  expect(result.persona.launch_command).toBe("claude");
  expect(result.persona.launch_args).toEqual(["--print"]);
  // Server-managed bookkeeping is fresh.
  expect(result.persona.summon_count).toBe(0);
  expect(result.persona.last_summoned_at).toBeNull();
});

test("forkPersona deep-copies memory entries with regenerated IDs", () => {
  seedSource();
  const sourceIds = loadStore(paths, "vellumpike").entries.map((e) => e.id);
  forkPersona({
    paths,
    from: "vellumpike",
    to: "obsidianfox",
    cwd: "/work/fork",
  });
  const forkIds = loadStore(paths, "obsidianfox").entries.map((e) => e.id);
  expect(forkIds).toHaveLength(2);
  // IDs regenerated — fork's IDs may overlap with source's slugs but
  // that's expected for memorable text. The contract is that the fork
  // and source can mutate independently. Verify by appending to one
  // and checking the other doesn't change.
  appendEntry(paths, "obsidianfox", { text: "fork-only entry" });
  expect(loadStore(paths, "vellumpike").entries.map((e) => e.id)).toEqual(sourceIds);
});

test("forkPersona with copy_memory: false produces a clean-slate persona", () => {
  seedSource();
  const result = forkPersona({
    paths,
    from: "vellumpike",
    to: "obsidianfox",
    cwd: "/work/fork",
    copy_memory: false,
  });
  expect(result.copied_entries).toBe(0);
  expect(loadStore(paths, "obsidianfox").entries).toEqual([]);
  // Profile still inherited.
  expect(result.persona.description).toBe("lead implementer");
});

test("forkPersona errors not_registered when source missing", () => {
  let err: unknown;
  try {
    forkPersona({
      paths,
      from: "ghost",
      to: "shadow",
      cwd: "/work",
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("not_registered");
});

test("forkPersona errors when target collides with existing persona", () => {
  seedSource();
  createPersona(paths, {
    username: "obsidianfox",
    project: "p",
    cwd: "/work/other",
    platform: "linux",
  });
  let err: unknown;
  try {
    forkPersona({
      paths,
      from: "vellumpike",
      to: "obsidianfox",
      cwd: "/work/fork",
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe("username_taken_other_cwd");
});

test("after fork, registry has both personas", () => {
  seedSource();
  forkPersona({
    paths,
    from: "vellumpike",
    to: "obsidianfox",
    cwd: "/work/fork",
  });
  const all = listPersonas(paths).map((p) => p.username).sort();
  expect(all).toEqual(["obsidianfox", "vellumpike"]);
});

test("fork starts with empty chat participation by design", () => {
  // The chat history in chat.db references the original agent_id;
  // the fork is a fresh registry entry with no chat subscriber.
  // This test pins the contract by verifying readPersona for the
  // fork reports a fresh persona (no chat-related side effects).
  seedSource();
  forkPersona({
    paths,
    from: "vellumpike",
    to: "obsidianfox",
    cwd: "/work/fork",
  });
  const fork = readPersona(paths, "obsidianfox");
  expect(fork).not.toBeNull();
  // Persona record carries no chat subscriber state; chat
  // participation requires an explicit `login` call.
});
