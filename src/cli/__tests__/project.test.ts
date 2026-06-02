import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runProject } from "../project.ts";
import { isProjectSingleAgent, resolvePaths } from "../../storage/index.ts";
import { EXIT_CODES } from "../exit-codes.ts";

let tmpDir: string;
let prevHome: string | undefined;
let out: string[];
const realWrite = process.stdout.write.bind(process.stdout);
const realErrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-cli-project-"));
  prevHome = process.env.PANTHEON_HOME;
  process.env.PANTHEON_HOME = tmpDir;
  out = [];
  // Capture stdout/stderr so the subcommand's prints don't pollute test output.
  process.stdout.write = ((s: string) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = realWrite;
  process.stderr.write = realErrWrite;
  if (prevHome === undefined) delete process.env.PANTHEON_HOME;
  else process.env.PANTHEON_HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("project single-agent <project> enables the lock", async () => {
  const code = await runProject({ args: ["single-agent", "solo"] });
  expect(code).toBe(EXIT_CODES.SUCCESS);
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  expect(isProjectSingleAgent(paths, "solo")).toBe(true);
});

test("project single-agent <project> --off disables the lock", async () => {
  await runProject({ args: ["single-agent", "solo"] });
  const code = await runProject({ args: ["single-agent", "solo", "--off"] });
  expect(code).toBe(EXIT_CODES.SUCCESS);
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  expect(isProjectSingleAgent(paths, "solo")).toBe(false);
});

test("project single-agent without a project name is a user error", async () => {
  const code = await runProject({ args: ["single-agent"] });
  expect(code).toBe(EXIT_CODES.USER_ERROR);
});

test("project show reflects the stored flag", async () => {
  await runProject({ args: ["single-agent", "solo"] });
  out = [];
  const code = await runProject({ args: ["show", "solo"] });
  expect(code).toBe(EXIT_CODES.SUCCESS);
  expect(out.join("")).toContain("single_agent: true");
});

test("unknown action is a user error", async () => {
  const code = await runProject({ args: ["frobnicate"] });
  expect(code).toBe(EXIT_CODES.USER_ERROR);
});
