import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  appendEntry,
  beginSession,
  decayOnLoad,
  getEntry,
  sweepDueReminders,
  updateEntry,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-decay-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function handoff(topic: string) {
  return appendEntry(paths, USER, { text: `handoff for ${topic}`, kind: "handoff", topic });
}

// --- beginSession ---

test("beginSession increments the per-persona ordinal", () => {
  expect(beginSession(paths, USER)).toBe(1);
  expect(beginSession(paths, USER)).toBe(2);
  expect(beginSession(paths, USER)).toBe(3);
});

// --- handoff §8 ---

test("off-topic session leaves a handoff frozen (not delivered, not advanced)", () => {
  const h = handoff("memory");
  decayOnLoad(paths, USER, ["chat"], 5);
  const got = getEntry(paths, USER, h.id)!;
  expect(got.status).toBe("active");
  expect(got.matched).toBeUndefined();
});

test("exact-focus session (A == {H}) autofades the handoff after one session", () => {
  const h = handoff("memory");
  decayOnLoad(paths, USER, ["memory"], 5);
  expect(getEntry(paths, USER, h.id)!.status).toBe("faded");
});

test("partial-match advances matched once per session, fades at threshold 3", () => {
  const h = handoff("memory");
  // A = {memory, chat} ⊃ {memory} but ≠ {memory} → partial.
  decayOnLoad(paths, USER, ["memory", "chat"], 1);
  expect(getEntry(paths, USER, h.id)!.matched).toBe(1);
  // Same session again → no double count.
  decayOnLoad(paths, USER, ["memory", "chat"], 1);
  expect(getEntry(paths, USER, h.id)!.matched).toBe(1);
  // Session 2.
  decayOnLoad(paths, USER, ["memory", "chat"], 2);
  expect(getEntry(paths, USER, h.id)!.matched).toBe(2);
  expect(getEntry(paths, USER, h.id)!.status).toBe("active");
  // Session 3 → matched 3 → fade.
  decayOnLoad(paths, USER, ["memory", "chat"], 3);
  const got = getEntry(paths, USER, h.id)!;
  expect(got.matched).toBe(3);
  expect(got.status).toBe("faded");
});

test("a faded handoff is forgotten on the next matching session", () => {
  const h = handoff("memory");
  updateEntry(paths, USER, h.id, { status: "faded" });
  // Non-matching session → still faded.
  decayOnLoad(paths, USER, ["chat"], 1);
  expect(getEntry(paths, USER, h.id)!.status).toBe("faded");
  // Matching session → forgotten.
  decayOnLoad(paths, USER, ["memory"], 2);
  expect(getEntry(paths, USER, h.id)!.status).toBe("forgotten");
});

// --- next-session reminders ---

test("a next-session reminder fades once delivered in a later session", () => {
  // Created in session 1.
  const r = appendEntry(paths, USER, {
    text: "ping the watcher restart",
    kind: "reminder",
    topic: "chat",
    due: "next-session",
    session_seq: 1,
  });
  // Same session → not consumed.
  decayOnLoad(paths, USER, ["chat"], 1);
  expect(getEntry(paths, USER, r.id)!.status).toBe("active");
  // Later session → delivered + faded.
  decayOnLoad(paths, USER, ["chat"], 2);
  expect(getEntry(paths, USER, r.id)!.status).toBe("faded");
});

// --- date-reminder daemon sweep ---

test("sweepDueReminders surfaces past-due date reminders once (notified flag)", () => {
  const past = appendEntry(paths, USER, {
    text: "confirm the origin push",
    kind: "reminder",
    topic: "lifecycle",
    due: 1000,
  });
  const future = appendEntry(paths, USER, {
    text: "later thing",
    kind: "reminder",
    topic: "lifecycle",
    due: 9_000_000_000_000,
  });
  const first = sweepDueReminders(paths, USER, 5000);
  expect(first.map((e) => e.id)).toEqual([past.id]);
  expect(getEntry(paths, USER, past.id)!.notified).toBe(true);
  // Second sweep → already notified → nothing.
  expect(sweepDueReminders(paths, USER, 5000)).toHaveLength(0);
  // Future reminder untouched.
  expect(getEntry(paths, USER, future.id)!.notified).toBeUndefined();
});
