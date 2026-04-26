import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runDoctor, formatDoctorReport } from "../doctor.ts";
import { openChatDb, resolvePaths } from "../../storage/index.ts";
import { createPersona } from "../../identity/index.ts";

let tmpDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-doctor-"));
  env = { PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("runDoctor: warnings on a fresh PANTHEON_HOME (no daemon has booted)", () => {
  const r = runDoctor(env);
  expect(r.warnings.length).toBeGreaterThan(0);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
});

test("runDoctor: healthy after a daemon boot (data dirs + chat.db exist)", () => {
  const paths = resolvePaths(env);
  // Simulate a daemon boot by opening chat.db (runs migrations) +
  // creating a persona.
  const db = openChatDb(paths.chatDbPath);
  db.close();
  createPersona(paths, {
    username: "alpha",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
  const r = runDoctor(env);
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
  // Schema version reported.
  expect(r.info.find((i) => i.check === "chat_db_schema")?.result).toContain("version");
  // Persona count > 0.
  expect(r.info.find((i) => i.check === "personas")?.result).toContain("1 registered");
});

test("formatDoctorReport: HEALTHY marker on ok=true; ISSUES on ok=false", () => {
  const happy = runDoctor(env);
  expect(formatDoctorReport(happy)).toContain("HEALTHY");

  const sad = { ...happy, ok: false, errors: ["something broke"] };
  expect(formatDoctorReport(sad)).toContain("ISSUES");
  expect(formatDoctorReport(sad)).toContain("something broke");
});
