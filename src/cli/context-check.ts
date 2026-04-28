/** `pantheon context-check` — Stop-hook handler.
 *
 * CC's Stop event payload arrives on stdin as JSON:
 *   { session_id, transcript_path, hook_event_name, cwd, stop_reason }
 *
 * Flow:
 *   1. Read & parse stdin.
 *   2. Look up the runtime env file (`~/.pantheon/runtime/env-<id>.json`)
 *      — written by the MCP server at boot. If missing, no-op (`{}`).
 *   3. Tail the transcript to find the most recent assistant turn's
 *      token usage.
 *   4. Compute `used / window` fraction; pick the highest unfired
 *      threshold that's been crossed; render the message.
 *   5. Emit a CC hook decision JSON: either `{decision: "block", ...}`
 *      or `{hookSpecificOutput: {additionalContext, ...}}`.
 *
 * On any error, emit `{}` (CC ignores empty hooks). The Stop hook
 * runs on EVERY agent turn end — must not throw and must be cheap.
 *
 * Memory-save heuristic: if the threshold would block but the agent
 * already saved memory in the latest assistant turn, downgrade to
 * a non-block reminder. Keeps the hook from re-blocking right after
 * the agent did the right thing. */

import fs from "node:fs";
import {
  detectWindowFromModel,
  isContextCheckDisabled,
  renderThresholdMessage,
  selectThreshold,
  shouldResetFired,
} from "./context-thresholds.ts";
import {
  readFired,
  readRuntimeEnv,
  writeFired,
} from "./runtime-bridge.ts";

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  cwd?: string;
  stop_reason?: string;
}

interface AssistantUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: AssistantUsage;
    content?: unknown;
  };
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload));
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function tailFile(p: string, bytes: number): string {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const stat = fs.fstatSync(fd);
      const size = stat.size;
      const start = Math.max(0, size - bytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function findLatestAssistant(transcriptPath: string): {
  usage: AssistantUsage;
  model?: string;
} | null {
  const tail = tailFile(transcriptPath, 256 * 1024);
  if (!tail) return null;
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.type !== "assistant") continue;
    const msg = parsed.message;
    if (!msg || msg.role !== "assistant") continue;
    if (!msg.usage) continue;
    return msg.model !== undefined
      ? { usage: msg.usage, model: msg.model }
      : { usage: msg.usage };
  }
  return null;
}

const SAVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mcp__pantheon__append_memory",
  "mcp__pantheon__update_memory",
  "mcp__pantheon__set_memory",
  "mcp__pantheon__snapshot_memory",
  "mcp__pantheon__rest",
]);

function transcriptHadRecentMemorySave(transcriptPath: string): boolean {
  const tail = tailFile(transcriptPath, 256 * 1024);
  if (!tail) return false;
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.type !== "assistant") continue;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use"
      ) {
        const name = (block as { name?: string }).name ?? "";
        if (SAVE_TOOL_NAMES.has(name)) return true;
      }
    }
  }
  return false;
}

export function runContextCheck(): void {
  try {
    if (isContextCheckDisabled()) {
      emit({});
      return;
    }
    const raw = readStdinSync();
    if (!raw) {
      emit({});
      return;
    }
    let input: StopHookInput;
    try {
      input = JSON.parse(raw) as StopHookInput;
    } catch {
      emit({});
      return;
    }
    const sessionId = input.session_id;
    const transcriptPath = input.transcript_path;
    if (!sessionId || !transcriptPath) {
      emit({});
      return;
    }
    const env = readRuntimeEnv(sessionId);
    if (!env) {
      emit({});
      return;
    }
    const latest = findLatestAssistant(transcriptPath);
    if (!latest) {
      emit({});
      return;
    }
    const used =
      (latest.usage.input_tokens ?? 0) +
      (latest.usage.cache_creation_input_tokens ?? 0) +
      (latest.usage.cache_read_input_tokens ?? 0);
    const window = detectWindowFromModel(
      latest.model,
      env.context_window_override !== null
        ? String(env.context_window_override)
        : undefined,
    );
    if (!window || used <= 0) {
      emit({});
      return;
    }
    const fraction = used / window;

    let fired = readFired(sessionId);
    if (shouldResetFired(fraction, fired)) {
      fired = [];
      writeFired(sessionId, fired);
    }

    const selected = selectThreshold(env.context_thresholds, fraction, fired);
    if (!selected) {
      emit({});
      return;
    }

    let effective = selected;
    if (selected.block && transcriptHadRecentMemorySave(transcriptPath)) {
      effective = { ...selected, block: false };
    }

    fired.push(selected.fraction);
    writeFired(sessionId, fired);

    const msg = renderThresholdMessage(effective, fraction, used, window);
    if (effective.block && msg.blockReason) {
      emit({
        decision: "block",
        reason: msg.blockReason,
        suppressOutput: true,
        systemMessage: msg.systemMessage,
      });
      return;
    }
    emit({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: msg.additionalContext,
      },
      suppressOutput: true,
      systemMessage: msg.systemMessage,
    });
  } catch {
    emit({});
  }
}
