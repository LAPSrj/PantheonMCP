import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths, type Paths } from "../../storage/index.ts";
import {
  writeStatuslineSidecar,
  deleteStatuslineSidecar,
  statuslineSidecarPath,
} from "../statusline-sidecar.ts";

let tmp: string;
let paths: Paths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-sidecar-"));
  paths = resolvePaths({ PANTHEON_HOME: tmp } as NodeJS.ProcessEnv);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("writeStatuslineSidecar writes jq-readable JSON keyed by session id", () => {
  writeStatuslineSidecar(paths, "26ec40d3-d750-42f3-9b24-6f4d83c179b2", {
    persona: "vellumpike",
    chat: "vellumpike2",
    status: "shipping sidecar",
  });
  const p = statuslineSidecarPath(paths, "26ec40d3-d750-42f3-9b24-6f4d83c179b2");
  expect(p).toBe(
    path.join(tmp, "runtime", "statusline", "26ec40d3-d750-42f3-9b24-6f4d83c179b2"),
  );
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  expect(parsed).toEqual({
    persona: "vellumpike",
    chat: "vellumpike2",
    status: "shipping sidecar",
  });
});

test("writeStatuslineSidecar: null session id → no-op, no crash", () => {
  writeStatuslineSidecar(paths, null, { persona: "p", chat: "p", status: "s" });
  writeStatuslineSidecar(paths, undefined, { persona: "p", chat: "p", status: "s" });
  writeStatuslineSidecar(paths, "", { persona: "p", chat: "p", status: "s" });
  // statusline dir is never created when there's no session to key on
  expect(fs.existsSync(path.join(tmp, "runtime", "statusline"))).toBe(false);
});

test("writeStatuslineSidecar overwrites in place (status refresh)", () => {
  writeStatuslineSidecar(paths, "sid", {
    persona: "vellumpike",
    chat: "vellumpike",
    status: "first",
  });
  writeStatuslineSidecar(paths, "sid", {
    persona: "vellumpike",
    chat: "vellumpike",
    status: "second",
  });
  const parsed = JSON.parse(
    fs.readFileSync(statuslineSidecarPath(paths, "sid"), "utf8"),
  );
  expect(parsed.status).toBe("second");
  // no leftover temp files in the dir
  const entries = fs.readdirSync(path.join(tmp, "runtime", "statusline"));
  expect(entries).toEqual(["sid"]);
});

test("deleteStatuslineSidecar removes the file", () => {
  writeStatuslineSidecar(paths, "sid", { persona: "p", chat: "p", status: "s" });
  expect(fs.existsSync(statuslineSidecarPath(paths, "sid"))).toBe(true);
  deleteStatuslineSidecar(paths, "sid");
  expect(fs.existsSync(statuslineSidecarPath(paths, "sid"))).toBe(false);
});

test("deleteStatuslineSidecar: missing file / null id → no-op, no crash", () => {
  deleteStatuslineSidecar(paths, "never-written");
  deleteStatuslineSidecar(paths, null);
  deleteStatuslineSidecar(paths, undefined);
});
