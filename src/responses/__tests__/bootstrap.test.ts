import { test, expect } from "bun:test";
import { buildSummonBootstrap } from "../bootstrap.ts";
import type { Persona } from "../../identity/index.ts";

function persona(over: Partial<Persona> = {}): Persona {
  return {
    username: "swoopfinch",
    project: "image-gallery",
    cwd: "/tmp/test-cwd",
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
    summoner_username: "alice",
    rest_timeout: 3600,
  });
  expect(out).toContain("**swoopfinch**");
  expect(out).toContain("summoned by **alice**");
  // Identity section.
  expect(out).toContain("**Project:** image-gallery");
  expect(out).toContain("/tmp/test-cwd (wsl · Ubuntu-22.04)");
  expect(out).toContain("**Description:** block builder");
  expect(out).toContain("typescript, react");
  // Bootstrap steps reference the unified pantheon namespace.
  expect(out).toContain("mcp__pantheon__login");
  // v2 boot: list_topics → load_memory replaces the get_memory step.
  expect(out).toContain("mcp__pantheon__list_topics");
  expect(out).toContain("mcp__pantheon__load_memory");
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
    summoner_username: "alice",
    runtime_prompt: "you handle the gallery hero block",
  });
  expect(out).toContain("freshly-conjured agent");
  expect(out).toContain("conjured by **alice**");
  expect(out).toContain("PROVISIONAL");
  expect(out).toContain("mcp__pantheon__update_profile");
  expect(out).toContain("mcp__pantheon__login");
  expect(out).toContain("you handle the gallery hero block");
  // Standard-bootstrap-only markers must NOT leak in.
  expect(out).not.toContain("specialist agent summoned via pantheon");
});

test("chat_username_suffix embeds <persona><N> in the login call and notes the canonical identity", () => {
  const out = buildSummonBootstrap(persona(), {
    rest_timeout: 3600,
    chat_username_suffix: "2",
  });
  // Login call uses the suffixed handle.
  expect(out).toContain(
    `mcp__pantheon__login({ username: "swoopfinch2", project: "image-gallery"`,
  );
  expect(out).toContain("Use EXACTLY `swoopfinch2`");
  // Note clarifies persona identity stays canonical.
  expect(out).toContain("sibling-incarnation alias");
  expect(out).toContain("persona identity is still `swoopfinch`");
});

test("auto-suffix guidance: tells the agent to read auto_suffixed and surface the rename naturally", () => {
  const out = buildSummonBootstrap(persona(), { rest_timeout: 3600 });
  // The bootstrap explains the auto-suffix flow.
  expect(out).toContain("auto_suffixed");
  expect(out).toContain("sibling-incarnation slot");
  expect(out).toContain("normal and expected");
  // Concrete example shows the canonical-vs-suffixed distinction.
  expect(out).toContain("swoopfinch2");
});

test("collision fallback: rare-error path retains DO-NOT-logout + surface options guidance", () => {
  const out = buildSummonBootstrap(persona(), { rest_timeout: 3600 });
  // Manual error path is preserved as exception-only fallback.
  expect(out).toContain("DO NOT call `logout`");
  expect(out).toContain("options");
  // Auto-suffix is mentioned as the normal-case behavior.
  expect(out).toContain("auto-suffix handles peer collisions transparently");
});

test("non-WSL platform renders the platform line without the distro suffix", () => {
  const base = persona({ platform: "linux" });
  delete base.wsl_distro;
  const out = buildSummonBootstrap(base, { rest_timeout: 3600 });
  expect(out).toContain("(linux)");
  expect(out).not.toContain("Ubuntu-22.04");
});

test("step 0 instructs the agent to wait for MCP servers before acting (standard bootstrap)", () => {
  const out = buildSummonBootstrap(persona(), { rest_timeout: 3600 });
  // Headline step-0 anchor.
  expect(out).toContain("0. **Wait for your MCP servers to come up.**");
  // Names the harness signal channel so agents know what to look for.
  expect(out).toContain("<system-reminder>");
  // Concrete retry budget — keeps the wait bounded.
  expect(out).toContain("retry up to 5 times");
  // ToolSearch is the right tool to coax connecting MCPs into resolving.
  expect(out).toContain("ToolSearch");
  // Anti-hallucination guardrail.
  expect(out).toContain("Never fabricate tool responses");
  // Exhaustion path: surface verbatim + stop, don't loop silently.
  expect(out).toContain(
    `"pantheon MCP isn't connected after 15s — I can't bootstrap without it"`,
  );
  // Step 0 (wait) → step 1 (load memory) → step 2 (login), in order.
  const step0Idx = out.indexOf("0. **Wait for your MCP servers");
  const step1Idx = out.indexOf("1. **Load your memory");
  const step2Idx = out.indexOf("2. **Log into chat**");
  expect(step0Idx).toBeGreaterThanOrEqual(0);
  expect(step1Idx).toBeGreaterThan(step0Idx);
  expect(step2Idx).toBeGreaterThan(step1Idx);
});

test("step 0 also appears in the provisional bootstrap (parity with summon path)", () => {
  const out = buildSummonBootstrap(persona({ provisional: true }), {
    rest_timeout: 3600,
  });
  expect(out).toContain("0. **Wait for your MCP servers to come up.**");
  expect(out).toContain("retry up to 5 times");
  expect(out).toContain("Never fabricate tool responses");
  expect(out).toContain(
    `"pantheon MCP isn't connected after 15s — I can't bootstrap without it"`,
  );
});

test("remanifest handoff renders as a prelude above the bootstrap steps", () => {
  const out = buildSummonBootstrap(persona(), {
    rest_timeout: 3600,
    remanifest_handoff:
      "You were in the middle of investigating the chat-watcher session-expiry bug. Resume that.",
  });
  // Header for the prelude.
  expect(out).toContain("Remanifest handoff");
  // Body verbatim.
  expect(out).toContain("chat-watcher session-expiry bug");
  // Anticipated rename note for the agent.
  expect(out).toContain("auto-suffixed");
  // Prelude precedes the standard step 0.
  const preludeIdx = out.indexOf("Remanifest handoff");
  const step0Idx = out.indexOf("0. **Wait for your MCP servers");
  expect(preludeIdx).toBeGreaterThanOrEqual(0);
  expect(step0Idx).toBeGreaterThan(preludeIdx);
});

test("standard bootstrap without remanifest_handoff has no prelude block", () => {
  const out = buildSummonBootstrap(persona(), { rest_timeout: 3600 });
  expect(out).not.toContain("Remanifest handoff");
});
