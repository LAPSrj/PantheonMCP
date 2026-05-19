import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  ProjectMemoryError,
  appendProjectEntry,
  fadeProjectEntry,
  forgetProjectEntryWithLifecycleCoercion,
  getProjectEntry,
} from "../index.ts";

let tmpDir: string;
let paths: Paths;
const PROJECT = "pantheon";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-pm-lifecycle-"));
  paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("forget on a core project entry is coerced to fade", () => {
  const entry = appendProjectEntry(paths, PROJECT, {
    text: "Core project decision worth a full pass to survive.",
    core: true,
  });

  const result = forgetProjectEntryWithLifecycleCoercion(
    paths,
    PROJECT,
    entry.id,
  );

  expect(result.coerced).toBe("fade");
  expect(result.entry.status).toBe("faded");
  expect(result.reason).toContain("core entry");
  expect(getProjectEntry(paths, PROJECT, entry.id)!.status).toBe("faded");
});

test("forget on an active reference-kind project entry is coerced to fade", () => {
  const entry = appendProjectEntry(paths, PROJECT, {
    text: "Project-wide gotcha.",
    kind: "gotcha",
  });

  const result = forgetProjectEntryWithLifecycleCoercion(
    paths,
    PROJECT,
    entry.id,
  );

  expect(result.coerced).toBe("fade");
  expect(result.entry.status).toBe("faded");
  expect(result.reason).toContain("reference-kind entry");
});

test("forget on a FADED reference-kind project entry is NOT coerced", () => {
  const entry = appendProjectEntry(paths, PROJECT, {
    text: "Project gotcha previously faded.",
    kind: "gotcha",
  });
  fadeProjectEntry(paths, PROJECT, entry.id);

  const result = forgetProjectEntryWithLifecycleCoercion(
    paths,
    PROJECT,
    entry.id,
  );

  expect(result.coerced).toBeNull();
  expect(result.entry.status).toBe("forgotten");
});

test("forget on an active log-kind project entry is NOT coerced", () => {
  const entry = appendProjectEntry(paths, PROJECT, {
    text: "Project session log.",
    kind: "log",
  });

  const result = forgetProjectEntryWithLifecycleCoercion(
    paths,
    PROJECT,
    entry.id,
  );

  expect(result.coerced).toBeNull();
  expect(result.entry.status).toBe("forgotten");
});

test("forget on a non-existent project entry throws entry_not_found", () => {
  expect(() =>
    forgetProjectEntryWithLifecycleCoercion(paths, PROJECT, "no-such-id"),
  ).toThrow(ProjectMemoryError);
  try {
    forgetProjectEntryWithLifecycleCoercion(paths, PROJECT, "no-such-id");
  } catch (err) {
    expect((err as ProjectMemoryError).code).toBe("entry_not_found");
  }
});
