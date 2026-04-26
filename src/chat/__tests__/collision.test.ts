import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { createPersona } from "../../identity/index.ts";
import { isHandleAvailable, validateChatUsername } from "../collision.ts";
import { TombstoneMap } from "../tombstones.ts";
import type { Subscriber } from "../types.ts";

let tmpDir: string;
let paths: Paths;
let tombstones: TombstoneMap;

function sub(over: Partial<Subscriber> & { username: string }): Subscriber {
  return {
    agent_id: "fake",
    transient: false,
    project: "test",
    status: "",
    mode: "all",
    connected_at: 0,
    last_seen: 0,
    status_updated_at: 0,
    promoted_at: null,
    ...over,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-collision-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  tombstones = new TombstoneMap();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("validateChatUsername rejects invalid shapes", () => {
  expect(validateChatUsername("").ok).toBe(false);
  expect(validateChatUsername("has space").ok).toBe(false);
  expect(validateChatUsername("-leading").ok).toBe(false);
  expect(validateChatUsername("admin").ok).toBe(false);
});

test("validateChatUsername accepts dotted handles + digit suffixes", () => {
  expect(validateChatUsername("vellumpike").ok).toBe(true);
  expect(validateChatUsername("yap.smith").ok).toBe(true);
  // Digit suffix is allowed at the chat layer (incarnation handles).
  expect(validateChatUsername("vellumpike2").ok).toBe(true);
});

test("isHandleAvailable rejects when persona registered", () => {
  createPersona(paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
  const r = isHandleAvailable({
    username: "vellumpike",
    subscribers: [],
    tombstones,
    paths,
  });
  expect(r.available).toBe(false);
  if (!r.available) expect(r.reason).toBe("registered_persona");
});

test("isHandleAvailable rejects on subscriber exact match", () => {
  const subs = [sub({ username: "moth-whistle" })];
  const r = isHandleAvailable({
    username: "moth-whistle",
    subscribers: subs,
    tombstones,
    paths,
  });
  expect(r.available).toBe(false);
  if (!r.available) expect(r.reason).toBe("subscriber_taken");
});

test("isHandleAvailable allows same-handle reclaim within tombstone window (§10)", () => {
  // §10: tombstone enables the handle_recycled broadcast on same-name
  // rejoin within the window. It does NOT block the reclaim itself.
  tombstones.add("recently-left", "agent-1");
  const r = isHandleAvailable({
    username: "recently-left",
    subscribers: [],
    tombstones,
    paths,
  });
  expect(r.available).toBe(true);
});

test("isHandleAvailable rejects on registry prefix collision", () => {
  createPersona(paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/a",
    platform: "linux",
  });
  const r = isHandleAvailable({
    username: "vellumstone",
    subscribers: [],
    tombstones,
    paths,
  });
  expect(r.available).toBe(false);
  if (!r.available) expect(r.reason).toBe("registry_prefix_collision");
});

test("isHandleAvailable rejects on subscriber prefix collision", () => {
  const subs = [sub({ username: "mothwarble" })];
  const r = isHandleAvailable({
    username: "mothlight",
    subscribers: subs,
    tombstones,
    paths,
  });
  expect(r.available).toBe(false);
  if (!r.available) expect(r.reason).toBe("subscriber_prefix_collision");
});

test("isHandleAvailable allows incarnation handles (`<base><N>`)", () => {
  createPersona(paths, {
    username: "swoopfinch",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
  const r = isHandleAvailable({
    username: "swoopfinch2",
    subscribers: [],
    tombstones,
    paths,
  });
  // The incarnation rule overrides the prefix-collision check when
  // the candidate is a digit-suffix of the registered persona.
  expect(r.available).toBe(true);
});

test("isHandleAvailable allows dash-suffix incarnation handles (`<base>-<N>`)", () => {
  // Per Leandro's `--chat-username-suffix` proposal, both `swoopfinch2`
  // and `swoopfinch-2` should count as sibling-incarnations of
  // `swoopfinch`. Pre-existing code only recognized the dotless form.
  createPersona(paths, {
    username: "swoopfinch",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
  for (const candidate of ["swoopfinch-2", "swoopfinch_3", "swoopfinch9"]) {
    const r = isHandleAvailable({
      username: candidate,
      subscribers: [],
      tombstones,
      paths,
    });
    expect(r.available).toBe(true);
  }
});

test("isHandleAvailable still rejects non-incarnation prefix collisions", () => {
  // semaphoremole's edge case: a candidate that LOOKS like it could
  // be an incarnation (digits at the end) but the base doesn't match
  // any persona/subscriber falls through to the regular prefix-
  // collision check. Verify a non-digit candidate still trips on the
  // prefix walk against `swoopfinch`.
  createPersona(paths, {
    username: "swoopfinch",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
  const r = isHandleAvailable({
    username: "swoopster",
    subscribers: [],
    tombstones,
    paths,
  });
  expect(r.available).toBe(false);
  if (!r.available) {
    expect(r.reason).toBe("registry_prefix_collision");
  }
});

test("isHandleAvailable returns available for fresh handles", () => {
  const r = isHandleAvailable({
    username: "obsidianfox",
    subscribers: [],
    tombstones,
    paths,
  });
  expect(r.available).toBe(true);
});
