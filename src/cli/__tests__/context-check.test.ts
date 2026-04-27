import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { writeRuntimeEnv } from "../runtime-bridge.ts";

let tmp: string;
let env: NodeJS.ProcessEnv;

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const BIN = path.join(REPO_ROOT, "bin", "pantheon.ts");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-cc-test-"));
  env = { ...process.env, PANTHEON_HOME: tmp };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: Record<string, unknown>;
}

function runHook(stopEvent: unknown): RunResult {
  const r = spawnSync("bun", [BIN, "context-check"], {
    input: JSON.stringify(stopEvent),
    env,
    encoding: "utf8",
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    // leave empty
  }
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.status ?? -1,
    parsed,
  };
}

function writeTranscript(rows: unknown[]): string {
  const p = path.join(tmp, "transcript.jsonl");
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n"));
  return p;
}

test("context-check: empty stdin → empty {} (no-op)", () => {
  const r = spawnSync("bun", [BIN, "context-check"], {
    input: "",
    env,
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("{}");
});

test("context-check: no runtime env file → {} (foreign session)", () => {
  // Skip writeRuntimeEnv entirely.
  const transcriptPath = writeTranscript([
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: { input_tokens: 150_000 },
      },
    },
  ]);
  const r = runHook({
    session_id: "foreign-session",
    transcript_path: transcriptPath,
  });
  expect(r.exitCode).toBe(0);
  expect(r.parsed).toEqual({});
});

test("context-check: 0.72 fraction at default ladder → soft hint (additionalContext)", () => {
  writeRuntimeEnv(
    {
      claude_session_id: "sess-a",
      claude_pid: 0,
      cwd_at_boot: "/x",
      context_thresholds: [
        { fraction: 0.5, block: false },
        { fraction: 0.7, block: false },
        { fraction: 0.85, block: false },
      ],
      context_window_override: null,
      written_at: 0,
    },
    env,
  );
  const transcriptPath = writeTranscript([
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 100_000,
          cache_read_input_tokens: 44_000,
        },
      },
    },
  ]);
  const r = runHook({
    session_id: "sess-a",
    transcript_path: transcriptPath,
  });
  // 144000 / 200000 = 0.72 → fires 0.7 (highest crossed, not yet fired)
  expect(r.parsed.systemMessage).toContain("72%");
  expect(r.parsed.suppressOutput).toBe(true);
  const hookOut = r.parsed.hookSpecificOutput as { additionalContext?: string };
  expect(hookOut.additionalContext).toContain("[pantheon]");
  expect(hookOut.additionalContext).toContain("append_memory");
});

test("context-check: blocking threshold fires `decision: block`", () => {
  writeRuntimeEnv(
    {
      claude_session_id: "sess-b",
      claude_pid: 0,
      cwd_at_boot: "/x",
      context_thresholds: [{ fraction: 0.85, block: true }],
      context_window_override: null,
      written_at: 0,
    },
    env,
  );
  const transcriptPath = writeTranscript([
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: { input_tokens: 180_000 },
      },
    },
  ]);
  const r = runHook({
    session_id: "sess-b",
    transcript_path: transcriptPath,
  });
  expect(r.parsed.decision).toBe("block");
  expect(r.parsed.reason as string).toContain("STOP");
});

test("context-check: recent memory save downgrades block → reminder", () => {
  writeRuntimeEnv(
    {
      claude_session_id: "sess-c",
      claude_pid: 0,
      cwd_at_boot: "/x",
      context_thresholds: [{ fraction: 0.85, block: true }],
      context_window_override: null,
      written_at: 0,
    },
    env,
  );
  const transcriptPath = writeTranscript([
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: { input_tokens: 180_000 },
        content: [
          {
            type: "tool_use",
            name: "mcp__pantheon__append_memory",
            input: { text: "handoff note" },
          },
        ],
      },
    },
  ]);
  const r = runHook({
    session_id: "sess-c",
    transcript_path: transcriptPath,
  });
  // Block downgraded — must NOT have decision: block
  expect(r.parsed.decision).toBeUndefined();
  // But still should emit the reminder hookSpecificOutput
  const hookOut = r.parsed.hookSpecificOutput as { additionalContext?: string };
  expect(hookOut.additionalContext).toContain("[pantheon]");
});

test("context-check: re-firing the same threshold is suppressed (fired-set tracking)", () => {
  writeRuntimeEnv(
    {
      claude_session_id: "sess-d",
      claude_pid: 0,
      cwd_at_boot: "/x",
      context_thresholds: [{ fraction: 0.7, block: false }],
      context_window_override: null,
      written_at: 0,
    },
    env,
  );
  const transcriptPath = writeTranscript([
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        usage: { input_tokens: 144_000 },
      },
    },
  ]);
  const r1 = runHook({
    session_id: "sess-d",
    transcript_path: transcriptPath,
  });
  expect((r1.parsed.systemMessage as string)).toContain("72%");

  const r2 = runHook({
    session_id: "sess-d",
    transcript_path: transcriptPath,
  });
  // Already fired — second call must no-op.
  expect(r2.parsed).toEqual({});
});

test("context-check: malformed stdin JSON → {} (no throw)", () => {
  const r = spawnSync("bun", [BIN, "context-check"], {
    input: "not json{{{",
    env,
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("{}");
});
