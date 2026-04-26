import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateFile, detectType } from "../validate.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-validate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("detectType: persona for personas/<x>.json; memory for memory.json", () => {
  expect(detectType("/x/personas/foo.json")).toBe("persona");
  expect(detectType("/x/personas/foo/memory.json")).toBe("memory");
  expect(detectType("/x/something.json")).toBeNull();
});

test("validateFile: a well-formed persona passes", () => {
  const file = path.join(tmpDir, "personas", "alpha.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      username: "alpha",
      project: "pantheon",
      cwd: "/work",
      platform: "linux",
      launch_command: "claude",
      launch_args: [],
      description: "lead",
      expertise: ["bun"],
      owns: ["/work"],
      mode: "fresh",
      color: null,
      registered_at: 1,
      registered_by_pid: 999,
      last_summoned_at: null,
      last_rested_at: null,
      rest_reason: null,
      resume_session_id: null,
      session_name: null,
      summon_count: 0,
      provisional: false,
    }),
  );
  const r = validateFile(file);
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
});

test("validateFile: persona missing required fields reports each", () => {
  const file = path.join(tmpDir, "personas", "broken.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ username: "broken" }), // missing nearly everything
  );
  const r = validateFile(file);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("'project'"))).toBe(true);
  expect(r.errors.some((e) => e.includes("'cwd'"))).toBe(true);
});

test("validateFile: persona with invalid platform/mode reports each", () => {
  const file = path.join(tmpDir, "personas", "alpha.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      username: "alpha",
      project: "p",
      cwd: "/work",
      platform: "bogus",
      launch_command: "claude",
      launch_args: [],
      description: "d",
      expertise: [],
      owns: [],
      mode: "bogus",
      registered_at: 1,
      registered_by_pid: 1,
    }),
  );
  const r = validateFile(file);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("platform"))).toBe(true);
  expect(r.errors.some((e) => e.includes("mode"))).toBe(true);
});

test("validateFile: a well-formed memory store passes", () => {
  const file = path.join(tmpDir, "personas", "alpha", "memory.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        { id: "decision-1", date: "2026-04-25T00:00:00Z", summary: "s", text: "t", status: "active" },
      ],
    }),
  );
  const r = validateFile(file);
  expect(r.ok).toBe(true);
});

test("validateFile: memory with bad version + duplicate ids + oversized summary reports each", () => {
  const file = path.join(tmpDir, "personas", "alpha", "memory.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 99,
      entries: [
        { id: "x", date: "2026-04-25T00:00:00Z", summary: "x".repeat(241), text: "t", status: "active" },
        { id: "x", date: "2026-04-25T00:00:00Z", summary: "y", text: "t", status: "wrong-status" },
      ],
    }),
  );
  const r = validateFile(file);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("version must be 1"))).toBe(true);
  expect(r.errors.some((e) => e.includes("duplicate id"))).toBe(true);
  expect(r.errors.some((e) => e.includes("summary > 240"))).toBe(true);
  expect(r.errors.some((e) => e.includes("status"))).toBe(true);
});

test("validateFile: missing file reports cleanly", () => {
  const r = validateFile(path.join(tmpDir, "personas", "ghost.json"));
  expect(r.ok).toBe(false);
  expect(r.errors[0]).toContain("File not found");
});

test("validateFile: --type override works when filename is unrecognized", () => {
  const file = path.join(tmpDir, "weird-name.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [] }));
  const auto = validateFile(file);
  expect(auto.ok).toBe(false);
  expect(auto.errors[0]).toContain("Cannot detect file type");

  const overridden = validateFile(file, "memory");
  expect(overridden.ok).toBe(true);
});
