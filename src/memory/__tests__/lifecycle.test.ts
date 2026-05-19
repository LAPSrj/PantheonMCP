import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  MemoryError,
  appendEntry,
  fadeEntry,
  forgetEntryWithLifecycleCoercion,
  getEntry,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const USER = "vellumpike";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-lifecycle-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("forget on a core entry is coerced to fade", () => {
  const entry = appendEntry(paths, USER, {
    text: "Core directive that should survive a single dream pass.",
    core: true,
  });

  const result = forgetEntryWithLifecycleCoercion(paths, USER, entry.id);

  expect(result.coerced).toBe("fade");
  expect(result.entry.status).toBe("faded");
  expect(result.reason).toContain("core entry");
  expect(getEntry(paths, USER, entry.id)!.status).toBe("faded");
});

test("forget on an active reference-kind entry (gotcha) is coerced to fade", () => {
  const entry = appendEntry(paths, USER, {
    text: "Recurring gotcha worth keeping for the next pass.",
    kind: "gotcha",
  });

  const result = forgetEntryWithLifecycleCoercion(paths, USER, entry.id);

  expect(result.coerced).toBe("fade");
  expect(result.entry.status).toBe("faded");
  expect(result.reason).toContain("reference-kind entry");
  expect(result.reason).toContain("kind=gotcha");
});

test("forget on each reference kind is coerced", () => {
  const referenceKinds = [
    "gotcha",
    "fact",
    "decision",
    "design",
    "cross-mcp-workflow",
    "sibling-network",
    "posture-rail",
  ];
  for (const kind of referenceKinds) {
    const entry = appendEntry(paths, USER, {
      text: `Active ${kind} entry.`,
      kind,
    });
    const result = forgetEntryWithLifecycleCoercion(paths, USER, entry.id);
    expect(result.coerced).toBe("fade");
    expect(result.entry.status).toBe("faded");
  }
});

test("forget on a FADED reference-kind entry is NOT coerced (already past the first tier)", () => {
  const entry = appendEntry(paths, USER, {
    text: "Reference entry that was faded in a prior pass.",
    kind: "gotcha",
  });
  fadeEntry(paths, USER, entry.id);

  const result = forgetEntryWithLifecycleCoercion(paths, USER, entry.id);

  expect(result.coerced).toBeNull();
  expect(result.entry.status).toBe("forgotten");
});

test("forget on an active LOG-kind entry is NOT coerced", () => {
  const entry = appendEntry(paths, USER, {
    text: "Session log; safe to forget when superseded.",
    kind: "log",
  });

  const result = forgetEntryWithLifecycleCoercion(paths, USER, entry.id);

  expect(result.coerced).toBeNull();
  expect(result.entry.status).toBe("forgotten");
});

test("forget on an active kind-less entry is NOT coerced", () => {
  const entry = appendEntry(paths, USER, {
    text: "Plain entry with no kind tag.",
  });

  const result = forgetEntryWithLifecycleCoercion(paths, USER, entry.id);

  expect(result.coerced).toBeNull();
  expect(result.entry.status).toBe("forgotten");
});

test("forget on a non-existent entry throws entry_not_found", () => {
  expect(() =>
    forgetEntryWithLifecycleCoercion(paths, USER, "no-such-id"),
  ).toThrow(MemoryError);
  try {
    forgetEntryWithLifecycleCoercion(paths, USER, "no-such-id");
  } catch (err) {
    expect((err as MemoryError).code).toBe("entry_not_found");
  }
});

test("core takes precedence over kind — core gotcha forgets coerce with core reason", () => {
  const entry = appendEntry(paths, USER, {
    text: "Core gotcha — load-bearing recurring-context.",
    kind: "gotcha",
    core: true,
  });

  const result = forgetEntryWithLifecycleCoercion(paths, USER, entry.id);

  expect(result.coerced).toBe("fade");
  expect(result.reason).toContain("core entry");
  expect(result.reason).not.toContain("reference-kind entry");
});
