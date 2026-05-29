import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, memoryFilePath, type Paths } from "../../storage/index.ts";
import {
  appendEntry,
  getEntry,
  listIndex,
  setMemory,
  updateEntry,
} from "../index.ts";

// Redesign-v2 schema additions (P1): all fields are optional + additive.
// These tests pin the storage round-trip and backwards-compatible reads.

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-mem-v2-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("appendEntry round-trips the v2 fields through disk", () => {
  const created = appendEntry(paths, USER, {
    text: "dm requires both scope:dm AND target:handle",
    summary: "when sending a dm, pass scope:dm AND target",
    kind: "rule",
    topic: "chat",
    pin: true,
    pin_reason: "load-bearing every session",
    supersedes: "chat/old-dm-rule",
    session_seq: 7,
  });
  const e = getEntry(paths, USER, created.id)!;
  expect(e.topic).toBe("chat");
  expect(e.pin).toBe(true);
  expect(e.pin_reason).toBe("load-bearing every session");
  expect(e.supersedes).toBe("chat/old-dm-rule");
  expect(e.session_seq).toBe(7);
});

test("reminder due round-trips (instant and next-session)", () => {
  const a = appendEntry(paths, USER, {
    text: "remind Leandro to confirm the origin push",
    kind: "reminder",
    topic: "lifecycle",
    due: 1780030001000,
  });
  expect(getEntry(paths, USER, a.id)!.due).toBe(1780030001000);

  const b = appendEntry(paths, USER, {
    text: "remind about the watcher restart",
    kind: "reminder",
    topic: "chat",
    due: "next-session",
  });
  expect(getEntry(paths, USER, b.id)!.due).toBe("next-session");
});

test("setMemory persists v2 fields", () => {
  const e = setMemory(paths, USER, {
    text: "we use bun, never npm",
    kind: "fact",
    topic: "always",
  });
  expect(getEntry(paths, USER, e.id)!.topic).toBe("always");
});

test("updateEntry patches v2 fields; pin:false clears pin+reason; due:null clears", () => {
  const e = appendEntry(paths, USER, {
    text: "x",
    kind: "rule",
    topic: "git",
    pin: true,
    pin_reason: "r",
    due: "next-session",
  });
  updateEntry(paths, USER, e.id, { topic: "git-internal", pin: false, due: null });
  const got = getEntry(paths, USER, e.id)!;
  expect(got.topic).toBe("git-internal");
  expect(got.pin).toBeUndefined();
  expect(got.pin_reason).toBeUndefined();
  expect(got.due).toBeUndefined();
});

test("updateEntry preserves untouched v2 fields (...current)", () => {
  const e = appendEntry(paths, USER, {
    text: "x",
    kind: "rule",
    topic: "memory",
    session_seq: 3,
  });
  updateEntry(paths, USER, e.id, { text: "y" });
  const got = getEntry(paths, USER, e.id)!;
  expect(got.topic).toBe("memory");
  expect(got.session_seq).toBe(3);
});

test("listIndex surfaces topic when present, omits when absent", () => {
  appendEntry(paths, USER, { text: "a", kind: "rule", topic: "chat" });
  appendEntry(paths, USER, { text: "b" }); // legacy-shaped, no topic
  const idx = listIndex(paths, USER, { status: "all" });
  const withTopic = idx.find((i) => i.topic === "chat");
  const without = idx.find((i) => i.topic === undefined);
  expect(withTopic).toBeDefined();
  expect(without).toBeDefined();
});

test("tolerant read: a legacy store with no v2 fields loads without crashing", () => {
  // Hand-write a pre-v2 store exactly as old code would have persisted it.
  const legacy = {
    version: 1,
    entries: [
      {
        id: "legacy-entry",
        date: "2026-01-01T00:00:00.000Z",
        summary: "old shape",
        text: "no v2 fields here",
        status: "active",
        kind: "log",
        core: true,
      },
    ],
  };
  const file = memoryFilePath(paths, USER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(legacy));

  const e = getEntry(paths, USER, "legacy-entry")!;
  expect(e.summary).toBe("old shape");
  expect(e.topic).toBeUndefined();
  expect(e.pin).toBeUndefined();
  expect(e.due).toBeUndefined();

  // And a v2 write alongside the legacy entry doesn't disturb it.
  appendEntry(paths, USER, { text: "new", kind: "rule", topic: "chat" });
  expect(getEntry(paths, USER, "legacy-entry")!.summary).toBe("old shape");
  const idx = listIndex(paths, USER, { status: "all" });
  expect(idx.length).toBe(2);
});
