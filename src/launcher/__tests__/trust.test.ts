import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureCwdTrusted } from "../trust.ts";

let tmpDir: string;
let cfgPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-trust-"));
  cfgPath = path.join(tmpDir, "claude.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readCfg(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
}

test("creates the file from scratch when absent and trusts the cwd", () => {
  const r = ensureCwdTrusted("/work/swoopfinch", { claudeJsonPath: cfgPath });
  expect(r.trusted_now).toBe(true);
  expect(r.trusted_already).toBe(false);
  const cfg = readCfg();
  const projects = cfg.projects as Record<string, Record<string, unknown>>;
  expect(projects["/work/swoopfinch"]?.hasTrustDialogAccepted).toBe(true);
  expect(projects["/work/swoopfinch"]?.hasCompletedOnboarding).toBe(true);
  expect(projects["/work/swoopfinch"]?.allowedTools).toEqual([]);
});

test("idempotent: second call on a trusted cwd returns trusted_already=true and does not rewrite", () => {
  ensureCwdTrusted("/work/swoopfinch", { claudeJsonPath: cfgPath });
  const mtime1 = fs.statSync(cfgPath).mtimeMs;
  // Spin briefly so a re-write would show a different mtime.
  const r2 = ensureCwdTrusted("/work/swoopfinch", { claudeJsonPath: cfgPath });
  expect(r2.trusted_already).toBe(true);
  expect(r2.trusted_now).toBe(false);
  const mtime2 = fs.statSync(cfgPath).mtimeMs;
  expect(mtime2).toBe(mtime1);
});

test("preserves other top-level keys and other project entries", () => {
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      version: "1.2.3",
      projects: {
        "/work/other": { hasTrustDialogAccepted: true, allowedTools: ["x"] },
      },
      preferences: { theme: "dark" },
    }),
  );
  const r = ensureCwdTrusted("/work/swoopfinch", { claudeJsonPath: cfgPath });
  expect(r.trusted_now).toBe(true);
  const cfg = readCfg();
  expect(cfg.version).toBe("1.2.3");
  expect((cfg.preferences as Record<string, unknown>).theme).toBe("dark");
  const projects = cfg.projects as Record<string, Record<string, unknown>>;
  expect(projects["/work/other"]?.hasTrustDialogAccepted).toBe(true);
  expect(projects["/work/other"]?.allowedTools).toEqual(["x"]);
  expect(projects["/work/swoopfinch"]?.hasTrustDialogAccepted).toBe(true);
});

test("upgrades an existing entry that lacks hasTrustDialogAccepted, preserving other fields", () => {
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      projects: {
        "/work/swoopfinch": { allowedTools: ["Read", "Edit"], custom: "v" },
      },
    }),
  );
  const r = ensureCwdTrusted("/work/swoopfinch", { claudeJsonPath: cfgPath });
  expect(r.trusted_now).toBe(true);
  const projects = readCfg().projects as Record<string, Record<string, unknown>>;
  const entry = projects["/work/swoopfinch"]!;
  expect(entry.hasTrustDialogAccepted).toBe(true);
  expect(entry.hasCompletedOnboarding).toBe(true);
  expect(entry.allowedTools).toEqual(["Read", "Edit"]);
  expect(entry.custom).toBe("v");
});

test("upgrades when hasTrustDialogAccepted is explicitly false", () => {
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      projects: { "/work/swoopfinch": { hasTrustDialogAccepted: false } },
    }),
  );
  const r = ensureCwdTrusted("/work/swoopfinch", { claudeJsonPath: cfgPath });
  expect(r.trusted_now).toBe(true);
  const projects = readCfg().projects as Record<string, Record<string, unknown>>;
  expect(projects["/work/swoopfinch"]?.hasTrustDialogAccepted).toBe(true);
});

test("malformed JSON returns a warning, does not throw, leaves the file alone", () => {
  fs.writeFileSync(cfgPath, "{not-json");
  const r = ensureCwdTrusted("/work/swoopfinch", { claudeJsonPath: cfgPath });
  expect(r.warning).toContain("claude_trust:");
  expect(r.trusted_now).toBe(false);
  expect(r.trusted_already).toBe(false);
  // File untouched.
  expect(fs.readFileSync(cfgPath, "utf8")).toBe("{not-json");
});
