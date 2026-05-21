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
  /** Total active+faded entries in the store before the per-pass cap
   * (see `MAX_SNAPSHOT_ENTRIES`). When greater than `entries.length`
   * the snapshot is a stalest-first slice and the remainder is
   * deferred to the next dream pass. Omitted by callers that build a
   * snapshot literal without capping. */
  total_candidates?: number;
}

export interface LibrarianOptions {
  /** Timeout for the subprocess (ms). When omitted, scaled to the
   * entry count: `60_000 + entries * 3_000` ms, capped at 600_000
   * (10 minutes). A 60s flat default failed in the wild on 33-entry
   * personas (filmstoat 2026-05-12); the scaled version gives the
   * librarian breathing room proportional to the body it has to
   * read. Pass an explicit value to override scaling. */
  timeout_ms?: number;
  /** Path to the `claude` binary. Defaults to looking in PATH. */
  claude_bin?: string;
  /** Model override. Default `claude-sonnet-4-6`. */
  model?: string;
}

const TIMEOUT_BASE_MS = 60_000;
const TIMEOUT_PER_ENTRY_MS = 3_000;
const TIMEOUT_CAP_MS = 600_000;

/** Compute the default timeout for a snapshot of N entries. Exposed
 * for tests and for callers that want to surface the value in
 * pre-flight diagnostics. */
export function defaultLibrarianTimeout(entryCount: number): number {
  const scaled = TIMEOUT_BASE_MS + entryCount * TIMEOUT_PER_ENTRY_MS;
  return Math.min(scaled, TIMEOUT_CAP_MS);
}

export interface Librarian {
  run(snapshot: LibrarianSnapshot, options?: LibrarianOptions): Promise<DreamPlan>;
}

export const DREAM_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  required: ["fade", "forget", "consolidate"],
  additionalProperties: false,
  properties: {
    /** Optional one-line summary of the librarian's overall posture
     * for this pass. Surfaces in the dream_log audit entry's summary
     * when present. Useful for "I was conservative — most entries
     * were reference-shape and stayed" vs "aggressive cleanup of
     * stale session logs." */
    posture_summary: { type: "string", maxLength: 240 },
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

## Lifecycle rule (HARD CONSTRAINT)

Each dream pass can demote an entry by AT MOST ONE status tier:
  - active+core    → fade   (NEVER forget core directly)
  - active non-core → fade or forget (forget only if explicit supersession exists)
  - faded          → forget
  - active         → forget is allowed only with a citation of the superseding entry id in your reason
  - **Consolidate is ALWAYS considered before forget.** If a candidate for forget could fold into a consolidate set instead, choose consolidate.

A core entry survives at least one full dream cycle before it can be lost. The applier will coerce any \`forget\` action targeting a \`core: true\` entry to \`fade\` and surface the coercion in the audit log; don't try to violate the rule.

## Action vocabulary

**fade(id, reason?)** — entry is still useful but stale; collapse to summary-only on render. The default demotion for active+core entries that have been superseded.

**forget(id, reason?)** — entry's information is wrong, retracted, or fully subsumed. Tombstoned (kept on disk for restore; hidden from default reads). Per the lifecycle rule, prefer fade for active and forget for already-faded entries.

**consolidate(source_ids, new_entry, reason?)** — N entries cover the same topic and can be merged into one. Source entries are forgotten by the applier after the new entry is appended.

## Typology by \`kind\` (forget-threshold defaults)

Entries fall into rough categories by their \`kind\` tag:

  - **REFERENCE** (\`kind\`: gotcha, fact, cross-mcp-workflow, sibling-network, posture-rail): forget-resistant. Fade when stale; forget requires EXPLICIT contradiction by a newer entry. These carry recurring-context knowledge that's expensive to re-derive.
  - **LOG** (\`kind\`: log, wrap, handoff, _unspecified for short notes): forget-eligible when superseded by a completion entry. Often candidates for consolidation when a chain references the same artifact.
  - **DECISION** (\`kind\`: decision, design): prefer consolidate when there's a chain; forget only when explicitly retracted.
  - **CORE** (any \`kind\` with \`core: true\`): the user explicitly pinned this. Fade-only by default; forget requires citing the superseding entry id in your reason — and even then the applier will coerce to fade per the lifecycle rule above.

## Consolidation triggers

Treat as a consolidation candidate any cluster where:
  - 3 or more entries cite the same artifact identifier — block name, commit SHA, manifest path, file path, persona handle — AND that artifact has landed in a committed state (i.e., a "completion" or "shipped" entry is present in the chain), OR
  - 3 or more entries form a \`replies_to\` chain on the same thread, OR
  - 3 or more handoff/wrap entries on the same topic spread across multiple dates.

In each case, prefer ONE 1–2 KB arc summary keyed off the artifact (commit SHA / block name) over forgetting the chain. Fade the sources after appending the consolidated entry — DO NOT include them in \`forget\` — the applier handles their lifecycle.

EXAMPLE: 5 entries cite block FooBar's build phases ending at commit \`abc1234\`. Output:
\`\`\`
{"consolidate":[{"source_ids":["foo-phase-1","foo-phase-2","foo-phase-3","foo-phase-4","foo-complete"],"new_entry":{"summary":"FooBar build lineage — commit abc1234","text":"Phase 1: cache built ... Phase 2: ... → final commit abc1234.","kind":"decision"},"reason":"5-entry chain referencing committed artifact abc1234"}],"fade":[],"forget":[]}
\`\`\`

## Posture

Be conservative. When in doubt, leave the entry alone — false-negatives ("librarian skipped a cleanup") are recoverable on the next dream; false-positives (forgetting load-bearing knowledge) require restore-from-tombstone.

Output a JSON object literally matching:

  {"fade":[...],"forget":[...],"consolidate":[...]}

All three keys are required, even when empty arrays. No top-level extras.`;

/** Default librarian — spawns `claude -p`. */
export class ClaudeCliLibrarian implements Librarian {
  async run(
    snapshot: LibrarianSnapshot,
    options: LibrarianOptions = {},
  ): Promise<DreamPlan> {
    const timeout =
      options.timeout_ms ?? defaultLibrarianTimeout(snapshot.entries.length);
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
