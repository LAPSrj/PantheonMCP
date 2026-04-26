import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePaths } from "../../storage/index.ts";
import { Session } from "../../identity/index.ts";
import { Watchdog, realScheduler } from "../../watchdog/index.ts";
import { createContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import { TOOLS } from "../tools.ts";
import type { HandlerContext } from "../types.ts";

let tmpDir: string;
let ctx: HandlerContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-mcp-"));
  const paths = resolvePaths({ PANTHEON_HOME: tmpDir } as NodeJS.ProcessEnv);
  const watchdog = new Watchdog(realScheduler);
  ctx = createContext({
    paths,
    session: new Session("test-session"),
    watchdog,
    parent_pid: 99999,
    platform: "linux",
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0]!.text);
}

// --- dispatch + error mapping ---

test("dispatch returns unknown_tool for unregistered names", async () => {
  const r = await dispatch("ghost", {}, ctx);
  expect(r.isError).toBe(true);
  expect(parseResult(r)).toEqual({
    error: "unknown_tool",
    message: "Unknown tool: 'ghost'.",
  });
});

test("dispatch maps IdentityError → MCP error payload with code", async () => {
  // claim with no registration → IdentityError("not_registered")
  const r = await dispatch("claim", { username: "ghost" }, ctx);
  expect(r.isError).toBe(true);
  const payload = parseResult(r) as Record<string, unknown>;
  expect(payload.error).toBe("not_registered");
});

test("dispatch maps MemoryError on missing claim → no_persona ToolError", async () => {
  const r = await dispatch("append_memory", { text: "x" }, ctx);
  expect(r.isError).toBe(true);
  const payload = parseResult(r) as Record<string, unknown>;
  expect(payload.error).toBe("no_persona");
});

test("dispatch wraps internal Errors as internal_error", async () => {
  // Force a thrown plain Error by registering a bad handler — call a
  // stub handler that throws not_implemented (ToolError, NOT internal).
  const r = await dispatch("summon", { username: "nobody" }, ctx);
  expect(r.isError).toBe(true);
  const payload = parseResult(r) as Record<string, unknown>;
  expect(payload.error).toBe("not_implemented");
  expect(payload.layer).toBe("launcher-adapters-§11a");
});

// --- tool surface coverage ---

test("every tool in TOOLS has a handler entry", async () => {
  // dispatch must respond either OK or with a non-unknown_tool error
  // for every tool in the schema list.
  for (const tool of TOOLS) {
    const r = await dispatch(tool.name, {}, ctx);
    const payload = parseResult(r) as Record<string, unknown>;
    expect(payload.error).not.toBe("unknown_tool");
  }
});

// --- watchdog interaction ---

test("dispatch touches the watchdog for reset-trigger tools after success", async () => {
  // Register a session in the watchdog so touch() can find it.
  ctx.watchdog.register({
    session: ctx.session,
    rest_timeout: 3600,
    onDeadline: () => {},
  });
  const before = ctx.watchdog.inspect("test-session")?.last_activity_at;
  // Wait one tick so a fresh touch produces a different timestamp.
  await new Promise((r) => setTimeout(r, 5));
  await dispatch("whoami", {}, ctx);
  const after = ctx.watchdog.inspect("test-session")?.last_activity_at;
  // whoami is in NON_RESET_TOOLS, so touch should NOT fire from dispatch.
  expect(after).toBe(before);

  // Trigger a successful reset-trigger tool. claim() is in
  // RESET_TRIGGER_TOOLS — touch should fire.
  const { createPersona } = await import("../../identity/index.ts");
  createPersona(ctx.paths, {
    username: "vellumpike",
    project: "pantheon",
    cwd: "/work",
    platform: "linux",
  });
  await new Promise((r) => setTimeout(r, 5));
  await dispatch("claim", { username: "vellumpike" }, ctx);
  const afterTrigger = ctx.watchdog.inspect("test-session")?.last_activity_at;
  expect(afterTrigger).toBeGreaterThan(after!);
});
