/** Librarian subprocess — the model that proposes a dream plan.
 *
 * Default impl shells out to `claude -p --model claude-sonnet-4-6`
 * with a librarian system prompt + the memory snapshot. Returns the
 * parsed DreamPlan. Tests inject a fake via the `Librarian` interface
 * so they don't actually fork a subprocess.
 *
 * Output validated by `validatePayload` against `DREAM_PLAN_SCHEMA`
 * (defined here, not registered with the schema registry — internal
 * pantheon machinery, not a typed user-facing message). Invalid plans
 * reject loud — better to no-op a dream than apply a hallucinated one. */

import { spawn } from "node:child_process";
import {
  validatePayload,
  type JsonSchema,
} from "../schemas/index.ts";
import { DreamError, type DreamPlan, type DreamScope } from "./types.ts";

/** Snapshot of memory passed to the librarian. Active + faded entries
 * with full text — forgotten entries are excluded (forgotten for a
 * reason; we trust the prior decision). */
export interface LibrarianSnapshot {
  scope: DreamScope;
  target: string;
  entries: Array<{
    id: string;
    summary: string;
    text: string;
    status: "active" | "faded";
    kind?: string;
    core?: boolean;
    date: string;
    /** Only set for project-memory dreams. */
    author_username?: string;
  }>;
}

export interface LibrarianOptions {
  /** Timeout for the subprocess (ms). Default 60_000. */
  timeout_ms?: number;
  /** Path to the `claude` binary. Defaults to looking in PATH. */
  claude_bin?: string;
  /** Model override. Default `claude-sonnet-4-6`. */
  model?: string;
}

export interface Librarian {
  run(snapshot: LibrarianSnapshot, options?: LibrarianOptions): Promise<DreamPlan>;
}

export const DREAM_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  required: ["fade", "forget", "consolidate"],
  additionalProperties: false,
  properties: {
    fade: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    forget: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    consolidate: {
      type: "array",
      items: {
        type: "object",
        required: ["source_ids", "new_entry"],
        additionalProperties: false,
        properties: {
          source_ids: {
            type: "array",
            items: { type: "string" },
          },
          new_entry: {
            type: "object",
            required: ["summary", "text"],
            additionalProperties: false,
            properties: {
              summary: { type: "string", maxLength: 240 },
              text: { type: "string" },
              kind: { type: "string" },
              core: { type: "boolean" },
            },
          },
          reason: { type: "string" },
          consolidated_from: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                author: { type: "string" },
                summary: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const LIBRARIAN_SYSTEM_PROMPT = `You are pantheon's librarian. Your job is to propose a JSON cleanup plan for an agent's memory store.

You will be given the agent's active + faded memory entries (full text). Output a single JSON object with three keys: \`fade\`, \`forget\`, \`consolidate\`. No prose, no preamble — JSON only.

**fade(id, reason?)** — entry is still useful but stale; collapse to summary-only on render. Use sparingly; the budget already collapses oldest-first.

**forget(id, reason?)** — entry's information is wrong, superseded, or no longer worth carrying. Tombstoned (kept on disk for restore; hidden from default reads). Use when:
  - A later entry contradicts/supersedes it.
  - It documents an in-flight task that is now done.
  - It captures debugging state for a bug that is closed.

**consolidate(source_ids, new_entry, reason?)** — N entries cover the same topic and can be merged into one. Source entries get forgotten; the consolidated entry replaces them. Use when:
  - Multiple handoffs / log entries on the same thread can fold into one summary.
  - A topic accumulated 3+ entries that together tell one story.
  Keep \`new_entry.summary\` ≤240 chars. Carry forward what matters; drop conversational scaffolding.

Be conservative. When in doubt, leave the entry alone. Output a JSON object literally matching:

  {"fade":[...],"forget":[...],"consolidate":[...]}

All three keys are required, even when empty arrays. No top-level extras.`;

/** Default librarian — spawns `claude -p`. */
export class ClaudeCliLibrarian implements Librarian {
  async run(
    snapshot: LibrarianSnapshot,
    options: LibrarianOptions = {},
  ): Promise<DreamPlan> {
    const timeout = options.timeout_ms ?? 60_000;
    const bin = options.claude_bin ?? "claude";
    const model = options.model ?? "claude-sonnet-4-6";

    const userPrompt = renderLibrarianUserPrompt(snapshot);
    const args = [
      "-p",
      "--model",
      model,
      "--append-system-prompt",
      LIBRARIAN_SYSTEM_PROMPT,
      userPrompt,
    ];

    const raw = await runSubprocessCapture(bin, args, timeout);
    return parseAndValidateLibrarianOutput(raw);
  }
}

function renderLibrarianUserPrompt(snapshot: LibrarianSnapshot): string {
  const header = `# Memory cleanup for ${snapshot.scope} ${snapshot.target}\n\n${snapshot.entries.length} entries — fade / forget / consolidate as warranted. JSON only.\n\n`;
  const body = snapshot.entries
    .map((e) => {
      const tags: string[] = [];
      if (e.core) tags.push("CORE");
      if (e.kind) tags.push(`kind=${e.kind}`);
      if (e.author_username) tags.push(`by=${e.author_username}`);
      tags.push(`status=${e.status}`);
      return [
        `## [${e.id}] (${e.date.slice(0, 10)}) ${tags.join(" ")}`,
        `> ${e.summary}`,
        e.text,
      ].join("\n");
    })
    .join("\n\n---\n\n");
  return header + body;
}

async function runSubprocessCapture(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new DreamError(
          "librarian_failed",
          `Failed to spawn ${bin}: ${err.message}`,
        ),
      );
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new DreamError(
            "librarian_timeout",
            `Librarian timed out after ${timeoutMs}ms.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new DreamError(
            "librarian_failed",
            `Librarian exited ${code}: ${stderr.slice(-500)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseAndValidateLibrarianOutput(raw: string): DreamPlan {
  // Try to extract the first {...} JSON block. Models sometimes emit
  // prose despite the prompt; carve it out best-effort.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) {
    throw new DreamError(
      "invalid_plan",
      "Librarian output contained no JSON object.",
      { raw: raw.slice(0, 200) },
    );
  }
  const candidate = raw.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new DreamError(
      "invalid_plan",
      `Librarian output failed JSON.parse: ${err instanceof Error ? err.message : String(err)}`,
      { raw: candidate.slice(0, 200) },
    );
  }
  const errors = validatePayload(parsed, DREAM_PLAN_SCHEMA);
  if (errors.length > 0) {
    throw new DreamError(
      "invalid_plan",
      `Librarian output failed schema validation: ${errors
        .slice(0, 5)
        .map((e) => `${e.path || "/"} — ${e.message}`)
        .join("; ")}`,
      { errors },
    );
  }
  return parsed as DreamPlan;
}
