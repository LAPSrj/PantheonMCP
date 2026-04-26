import { test, expect } from "bun:test";
import { buildSummonBootstrap } from "../bootstrap.ts";
import type { Persona } from "../../identity/index.ts";

function persona(over: Partial<Persona> = {}): Persona {
  return {
    username: "swoopfinch",
    project: "image-gallery",
    cwd: "/home/leandro/builder/nyus",
    platform: "wsl",
    wsl_distro: "Ubuntu-22.04",
    launch_command: "claude",
    launch_args: [],
    description: "block builder",
    expertise: ["typescript", "react"],
    owns: ["/repos/nyus/blocks/gallery"],
    mode: "fresh",
    color: "purple",
    registered_at: 1_700_000_000_000,
    registered_by_pid: 12345,
    last_summoned_at: null,
    last_rested_at: null,
    rest_reason: null,
    resume_session_id: null,
    session_name: null,
    summon_count: 0,
    provisional: false,
    ...over,
  };
}

test("standard bootstrap names the persona, project, and cwd; instructs login + watcher + memory", () => {
  const out = buildSummonBootstrap(persona(), {
    summoner_username: "leandro",
    rest_timeout: 3600,
  });
  expect(out).toContain("**swoopfinch**");
  expect(out).toContain("summoned by **leandro**");
  // Identity section.
  expect(out).toContain("**Project:** image-gallery");
  expect(out).toContain("/home/leandro/builder/nyus (wsl · Ubuntu-22.04)");
  expect(out).toContain("**Description:** block builder");
  expect(out).toContain("typescript, react");
  // Bootstrap steps reference the unified pantheon namespace.
  expect(out).toContain("mcp__pantheon__login");
  expect(out).toContain("mcp__pantheon__get_memory");
  expect(out).toContain("mcp__pantheon__update_status");
  // Login uses the EXACT username + project the spawn handler resolved.
  expect(out).toContain(
    `mcp__pantheon__login({ username: "swoopfinch", project: "image-gallery"`,
  );
  // Watcher instruction (Monitor + login response's note field).
  expect(out).toContain("Monitor(...)");
  // Color step present when persona has a color.
  expect(out).toContain("/color purple");
});

test("bootstrap omits color step when persona.color is null", () => {
  const out = buildSummonBootstrap(persona({ color: null }), {
    rest_timeout: 3600,
  });
  expect(out).not.toContain("/color");
  expect(out).not.toContain("Set your Claude session color");
});

test("rest_timeout=number renders the auto-rest ON block with minute count", () => {
  const out = buildSummonBootstrap(persona(), { rest_timeout: 1800 });
  expect(out).toContain("**Auto-rest is ON** (30 min");
  expect(out).not.toContain("**Auto-rest is OFF**");
});

test("rest_timeout='never' renders the auto-rest OFF block", () => {
  const out = buildSummonBootstrap(persona(), { rest_timeout: "never" });
  expect(out).toContain("**Auto-rest is OFF**");
  expect(out).not.toContain("**Auto-rest is ON**");
});

test("resume hint appears when persona has a resume_session_id", () => {
  const out = buildSummonBootstrap(persona({ resume_session_id: "session-abc" }), {
    rest_timeout: 3600,
  });
  expect(out).toContain("`session-abc`");
  expect(out).toContain("resume mode");
});

test("runtime prompt embedded under the From the summoner separator", () => {
  const out = buildSummonBootstrap(persona(), {
    rest_timeout: 3600,
    runtime_prompt: "ship the gallery hero block",
  });
  expect(out).toContain("## From the summoner");
  expect(out).toContain("ship the gallery hero block");
  // Bootstrap content precedes the runtime prompt.
  const bootstrapIdx = out.indexOf("Bootstrap — do these BEFORE responding");
  const runtimeIdx = out.indexOf("ship the gallery hero block");
  expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
  expect(runtimeIdx).toBeGreaterThan(bootstrapIdx);
});

test("empty runtime prompt yields a placeholder so structure stays consistent", () => {
  const out = buildSummonBootstrap(persona(), { rest_timeout: 3600 });
  expect(out).toContain("## From the summoner");
  expect(out).toContain("(no runtime prompt — derive your task from project context)");
});

test("provisional persona renders the conjure-bootstrap variant", () => {
  const out = buildSummonBootstrap(persona({ provisional: true }), {
    rest_timeout: 3600,
    summoner_username: "leandro",
    runtime_prompt: "you handle the gallery hero block",
  });
  expect(out).toContain("freshly-conjured agent");
  expect(out).toContain("conjured by **leandro**");
  expect(out).toContain("PROVISIONAL");
  expect(out).toContain("mcp__pantheon__update_profile");
  expect(out).toContain("mcp__pantheon__login");
  expect(out).toContain("you handle the gallery hero block");
  // Standard-bootstrap-only markers must NOT leak in.
  expect(out).not.toContain("specialist agent summoned via pantheon");
});

test("non-WSL platform renders the platform line without the distro suffix", () => {
  const base = persona({ platform: "linux" });
  delete base.wsl_distro;
  const out = buildSummonBootstrap(base, { rest_timeout: 3600 });
  expect(out).toContain("(linux)");
  expect(out).not.toContain("Ubuntu-22.04");
});
