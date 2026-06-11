import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolvePaths,
  readProjectConfig,
  setProjectSingleAgent,
} from "../../storage/index.ts";
import { createPersona, Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import { SINGLE_AGENT_HIDDEN } from "../tools.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-project-policy-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(single_agent = false): HandlerContext {
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  return createContext({
    paths,
    session: new Session("test-session"),
    watchdog: new Watchdog(realScheduler),
    parent_pid: 99999,
    platform: "linux",
    single_agent,
  });
}

function parse(r: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

function seedPersona(username: string, project: string) {
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  createPersona(paths, {
    username,
    project,
    cwd: `/tmp/${project}`,
    platform: "linux",
  });
}

// --- hidden-set composition ---

test("the _any project tools are hidden in single-agent; bare edit_project is not", () => {
  expect(SINGLE_AGENT_HIDDEN.has("list_projects_any")).toBe(true);
  expect(SINGLE_AGENT_HIDDEN.has("edit_project_any")).toBe(true);
  expect(SINGLE_AGENT_HIDDEN.has("edit_project")).toBe(false);
});

// --- list_projects_any ---

test("list_projects_any unions personas + on-disk projects with agent counts", async () => {
  seedPersona("alpha", "proj-a");
  seedPersona("beta", "proj-a");
  seedPersona("gamma", "proj-b");
  // proj-c has config but no personas (pre-configured lock).
  const ctx = makeCtx();
  await dispatch("edit_project_any", { project: "proj-c", single_agent: true }, ctx);

  const r = await dispatch("list_projects_any", {}, ctx);
  const payload = parse(r) as { count: number; projects: Array<Record<string, unknown>> };
  const byName = Object.fromEntries(payload.projects.map((p) => [p.name, p]));

  expect(payload.count).toBe(3);
  expect(byName["proj-a"]!.agent_count).toBe(2);
  expect(byName["proj-b"]!.agent_count).toBe(1);
  expect(byName["proj-c"]!.agent_count).toBe(0);
  expect(byName["proj-c"]!.single_agent).toBe(true);
});

test("list_projects_any surfaces description only when set", async () => {
  const ctx = makeCtx();
  await dispatch("edit_project_any", { project: "proj-a", description: "  the A project  " }, ctx);
  seedPersona("alpha", "proj-b");

  const r = await dispatch("list_projects_any", {}, ctx);
  const payload = parse(r) as { projects: Array<Record<string, unknown>> };
  const byName = Object.fromEntries(payload.projects.map((p) => [p.name, p]));
  expect(byName["proj-a"]!.description).toBe("the A project"); // trimmed
  expect("description" in byName["proj-b"]!).toBe(false);
});

// --- edit_project_any ---

test("edit_project_any sets single_agent and description, persisted to config", async () => {
  const ctx = makeCtx();
  const r = await dispatch(
    "edit_project_any",
    { project: "solo", single_agent: true, description: "locked project" },
    ctx,
  );
  const payload = parse(r);
  expect(payload.single_agent).toBe(true);
  expect(payload.description).toBe("locked project");
  expect(payload.changed).toEqual(["description", "single_agent"]);
  expect(String(payload.single_agent_effect)).toContain("IMMEDIATELY");

  const cfg = readProjectConfig(
    resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv),
    "solo",
  );
  expect(cfg.single_agent).toBe(true);
  expect(cfg.description).toBe("locked project");
});

test("disabling single_agent reports new-sessions-only timing", async () => {
  const ctx = makeCtx();
  await dispatch("edit_project_any", { project: "solo", single_agent: true }, ctx);
  const r = await dispatch("edit_project_any", { project: "solo", single_agent: false }, ctx);
  const payload = parse(r);
  expect(payload.single_agent).toBe(false);
  expect(String(payload.single_agent_effect)).toContain("NEW sessions only");
});

test("edit_project_any clears description with null", async () => {
  const ctx = makeCtx();
  await dispatch("edit_project_any", { project: "solo", description: "x" }, ctx);
  const r = await dispatch("edit_project_any", { project: "solo", description: null }, ctx);
  const payload = parse(r);
  expect("description" in payload).toBe(false);
  const cfg = readProjectConfig(
    resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv),
    "solo",
  );
  expect(cfg.description).toBeUndefined();
});

test("edit_project_any rejects an over-long description", async () => {
  const ctx = makeCtx();
  const r = await dispatch(
    "edit_project_any",
    { project: "solo", description: "x".repeat(161) },
    ctx,
  );
  expect(r.isError).toBe(true);
  expect(parse(r).error).toBe("description_too_long");
});

test("edit_project_any with neither field is nothing_to_edit", async () => {
  const ctx = makeCtx();
  const r = await dispatch("edit_project_any", { project: "solo" }, ctx);
  expect(r.isError).toBe(true);
  expect(parse(r).error).toBe("nothing_to_edit");
});

test("enabling single_agent is refused when 2+ personas are registered", async () => {
  seedPersona("alpha", "crowded");
  seedPersona("beta", "crowded");
  const ctx = makeCtx();
  const r = await dispatch("edit_project_any", { project: "crowded", single_agent: true }, ctx);
  expect(r.isError).toBe(true);
  const payload = parse(r);
  expect(payload.error).toBe("project_single_agent_conflict");
  expect(payload.count).toBe(2);
});

test("enabling single_agent is allowed with exactly one persona", async () => {
  seedPersona("alpha", "lonely");
  const ctx = makeCtx();
  const r = await dispatch("edit_project_any", { project: "lonely", single_agent: true }, ctx);
  expect(r.isError).toBeFalsy();
  expect(parse(r).single_agent).toBe(true);
});

test("disabling single_agent is never blocked by persona count", async () => {
  seedPersona("alpha", "crowded");
  seedPersona("beta", "crowded");
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  // Force the flag on out-of-band (simulating a project that grew after locking).
  setProjectSingleAgent(paths, "crowded", true);
  const ctx = makeCtx();
  const r = await dispatch("edit_project_any", { project: "crowded", single_agent: false }, ctx);
  expect(r.isError).toBeFalsy();
  expect(parse(r).single_agent).toBe(false);
});

// --- dispatch gating ---

test("dispatch blocks list_projects_any / edit_project_any in a single-agent session", async () => {
  const ctx = makeCtx(true);
  const r1 = await dispatch("list_projects_any", {}, ctx);
  expect(parse(r1).error).toBe("tool_unavailable_single_agent");
  const r2 = await dispatch("edit_project_any", { project: "x", single_agent: false }, ctx);
  expect(parse(r2).error).toBe("tool_unavailable_single_agent");
});

test("dispatch does NOT block bare edit_project in a single-agent session", async () => {
  const ctx = makeCtx(true);
  // No chat scope → it errors no_project_scope, but NOT the single-agent guard.
  const r = await dispatch("edit_project", { single_agent: false }, ctx);
  const payload = r.isError ? parse(r) : {};
  expect(payload.error).not.toBe("tool_unavailable_single_agent");
});
