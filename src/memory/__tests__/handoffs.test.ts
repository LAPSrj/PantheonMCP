import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import { createPersona } from "../../identity/index.ts";
import {
  HANDOFF_KIND,
  HANDOFF_TTL_MS,
  appendEntry,
  buildHandoffSeed,
  defaultHandoffExpiresAt,
  expireEntries,
  expireEntriesFor,
  loadStore,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-handoffs-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  createPersona(paths, {
    username: USER,
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("buildHandoffSeed: kind=handoff, NOT core, expires_at ~7d out, summary references target", () => {
  const seed = buildHandoffSeed("moth-whistle", "ship the thing", 1_000_000);
  expect(seed.kind).toBe(HANDOFF_KIND);
  // Handoffs are deliberately not core — they are ephemeral.
  expect((seed as { core?: unknown }).core).toBeUndefined();
  expect(seed.text).toBe("ship the thing");
  expect(seed.expires_at).toBe(1_000_000 + HANDOFF_TTL_MS);
  expect(seed.summary).toContain("moth-whistle");
  expect(seed.summary).toContain("7");
});

test("buildHandoffSeed: caller-supplied summary becomes the highlight", () => {
  const seed = buildHandoffSeed(
    "moth-whistle",
    "ship the thing",
    1_000_000,
    "  auth refactor half-done — see src/auth  ",
  );
  expect(seed.summary).toBe("auth refactor half-done — see src/auth");
});

test("buildHandoffSeed: blank summary falls back to boilerplate", () => {
  const seed = buildHandoffSeed("moth-whistle", "x", 1_000_000, "   ");
  expect(seed.summary).toContain("moth-whistle");
});

test("defaultHandoffExpiresAt = now + HANDOFF_TTL_MS", () => {
  expect(defaultHandoffExpiresAt(2000)).toBe(2000 + HANDOFF_TTL_MS);
});

test("appendEntry persists expires_at when supplied", () => {
  const seed = buildHandoffSeed("moth-whistle", "do the thing", 1_000_000);
  const entry = appendEntry(paths, USER, seed);
  expect(entry.expires_at).toBe(1_000_000 + HANDOFF_TTL_MS);
  expect(entry.kind).toBe(HANDOFF_KIND);
  expect(entry.core).toBeUndefined();
});

test("expireEntriesFor fades active handoff entries past expires_at", () => {
  const seed = buildHandoffSeed("target", "do the thing", 1_000_000);
  appendEntry(paths, USER, seed);
  // Sweep in the future — entry should fade.
  const faded = expireEntriesFor(paths, USER, 1_000_000 + HANDOFF_TTL_MS + 1);
  expect(faded).toBe(1);
  const after = loadStore(paths, USER).entries;
  expect(after[0]?.status).toBe("faded");
});

test("expireEntriesFor fades ANY kind once expires_at is past", () => {
  appendEntry(paths, USER, {
    text: "time-boxed note",
    kind: "decision",
    expires_at: 1_000,
  });
  const faded = expireEntriesFor(paths, USER, 999_999);
  expect(faded).toBe(1);
  expect(loadStore(paths, USER).entries[0]?.status).toBe("faded");
});

test("expireEntriesFor leaves entries without expires_at alone", () => {
  appendEntry(paths, USER, { text: "no ttl", kind: "fact" });
  const faded = expireEntriesFor(paths, USER, 9_999_999_999_999);
  expect(faded).toBe(0);
  expect(loadStore(paths, USER).entries[0]?.status).toBe("active");
});

test("expireEntriesFor leaves already-faded entries alone (idempotent)", () => {
  const seed = buildHandoffSeed("target", "x", 1_000_000);
  const entry = appendEntry(paths, USER, seed);
  // Manually fade.
  const { fadeEntry } = require("../operations.ts");
  fadeEntry(paths, USER, entry.id);
  // Sweep past expiry — already faded, no double-action.
  const faded = expireEntriesFor(paths, USER, 1_000_000 + HANDOFF_TTL_MS + 1);
  expect(faded).toBe(0);
});

test("expireEntries walks every persona", () => {
  createPersona(paths, {
    username: "moth-whistle",
    project: "pantheon",
    cwd: "/work/moth",
    platform: "linux",
  });
  appendEntry(paths, USER, buildHandoffSeed("a", "x", 1_000));
  appendEntry(paths, "moth-whistle", buildHandoffSeed("b", "y", 1_000));
  const faded = expireEntries(paths, 1_000 + HANDOFF_TTL_MS + 1);
  expect(faded).toBe(2);
});
