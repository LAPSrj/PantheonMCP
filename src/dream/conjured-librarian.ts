/** Conjured librarian — production dream-pass orchestrator.
 *
 * Replaces the `claude -p` subprocess librarian (ClaudeCliLibrarian)
 * with a real interactive `librarian-<target>` agent summoned in its
 * own terminal window. The librarian:
 *
 *   1. Receives a snapshot file path in its initial prompt.
 *   2. Reads the snapshot.
 *   3. `become`s the target persona (persona scope only; project scope
 *      uses the `_any` variants and skips become).
 *   4. Applies fades / forgets / consolidates via MCP. The §4
 *      lifecycle-coercion in `forget_memory` (`src/memory/lifecycle.ts`)
 *      protects core + active-reference entries from being forgotten
 *      directly regardless of the librarian's intent.
 *   5. Writes a `<snapshot>.result.json` file so this orchestrator
 *      knows the pass completed.
 *   6. `rest()` + `exit()`.
 *
 * This orchestrator:
 *   - Writes the snapshot to a stable on-disk location.
 *   - Calls the runtime-supplied `spawn` function (closure that wraps
 *     `conjure`/`summon` with the dream handler's context).
 *   - Polls for `<snapshot>.result.json` with a scaled timeout
 *     (defaultLibrarianTimeout — same scaling as before).
 *   - Parses + validates the result, returns it as DreamApplyResult.
 *
 * File-based handshake (not chat DM) keeps the failure mode simple:
 * snapshot + result stay on disk for forensics; orchestrator can
 * resume after a transient hiccup; chat-watcher death (a known issue
 * per ops memories) doesn't tank the dream pass.
 *
 * Tests inject a fake `Librarian` to bypass spawn entirely. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { Paths } from "../storage/index.ts";
import {
  validatePayload,
  type JsonSchema,
} from "../schemas/index.ts";
import {
  DreamError,
  type DreamApplyResult,
  type DreamScope,
} from "./types.ts";
import {
  defaultLibrarianTimeout,
  type LibrarianOptions,
  type LibrarianSnapshot,
} from "./librarian.ts";

/** Path to the librarian skill markdown. Read at orchestration time
 * and prepended to the librarian's initial prompt. */
const LIBRARIAN_SKILL_PATH = path.join(
  import.meta.dir,
  "librarian-skill.md",
);

/** Common Librarian interface — production `ConjuredLibrarian` and
 * test fakes both implement this. The dream handler holds the
 * module-singleton (settable via `setLibrarian`) and dispatches via
 * `run`. */
export interface Librarian {
  run(
    snapshot: LibrarianSnapshot,
    runtime: LibrarianRuntime,
    options?: LibrarianOptions,
  ): Promise<DreamApplyResult>;
}

/** Runtime context for a single dream pass. Carries everything the
 * orchestrator needs without dragging the full HandlerContext into
 * the dream module. */
export interface LibrarianRuntime {
  paths: Paths;
  /** Project the librarian persona is registered under (caller's
   * project for persona dreams; target project for project dreams). */
  defaultProject: string;
  /** Working directory inherited by the librarian session. */
  defaultCwd: string;
  /** Platform tag stamped on the librarian persona if it needs to
   * be conjured fresh. */
  defaultPlatform: "wsl" | "windows" | "mac" | "linux";
  /** Spawn entry-point — closes over the dream handler's context.
   * Conjures `librarian-<target>` if missing, summons otherwise. */
  spawn: LibrarianSpawner;
  /** Override the snapshot inbox dir. Defaults to
   * `<paths.stateDir>/dream/inbox/`. Tests use a tmp dir. */
  inbox_dir?: string;
  /** Polling interval for the result file (ms). Default 1000. */
  poll_interval_ms?: number;
}

/** Spawn entry-point used by the conjured librarian. Production wires
 * this to call `spawnPersona` / `createPersona` from the identity +
 * spawn handler layers; tests inject a fake that writes a synthetic
 * result file without actually launching a subprocess. */
export interface LibrarianSpawner {
  (input: LibrarianSpawnInput): Promise<void>;
}

export interface LibrarianSpawnInput {
  /** Persona handle to use: `librarian-<target>`. */
  username: string;
  /** Caller's project — librarian persona is registered under the
   * same project so the cross-project gate accepts the spawn. */
  project: string;
  /** Working directory the librarian inherits. */
  cwd: string;
  /** Platform passthrough so a freshly-registered librarian persona
   * carries the right platform tag (mostly relevant for `wsl`). */
  platform: "wsl" | "windows" | "mac" | "linux";
  /** Initial prompt (librarian-skill.md + task description). */
  prompt: string;
  /** True when `librarian-<target>` already exists in the registry;
   * false → spawner must conjure it before summoning. */
  preExisting: boolean;
}

/** JSON schema for `<snapshot>.result.json`. Surfaces what the
 * librarian self-reports; the orchestrator returns this verbatim
 * as the dream's apply-result. */
export const LIBRARIAN_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  required: [
    "scope",
    "target",
    "faded",
    "forgotten",
    "consolidated",
  ],
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: ["persona", "project"] },
    target: { type: "string" },
    faded: { type: "number" },
    forgotten: { type: "number" },
    consolidated: { type: "number" },
    audit_entry_id: { type: "string" },
    posture_summary: { type: "string", maxLength: 240 },
    notes: { type: "array", items: { type: "string" } },
  },
};

/** Production librarian — conjures `librarian-<target>` in a real
 * WT/kitty/tmux tab, hands it a snapshot file, waits for the result. */
export class ConjuredLibrarian implements Librarian {
  async run(
    snapshot: LibrarianSnapshot,
    runtime: LibrarianRuntime,
    options: LibrarianOptions = {},
  ): Promise<DreamApplyResult> {
    const timeoutMs =
      options.timeout_ms ?? defaultLibrarianTimeout(snapshot.entries.length);
    const inboxDir =
      runtime.inbox_dir ?? path.join(runtime.paths.stateDir, "dream", "inbox");
    const pollInterval = runtime.poll_interval_ms ?? 1000;

    await mkdir(inboxDir, { recursive: true });

    const snapshotPath = path.join(
      inboxDir,
      `${snapshot.scope}-${slugify(snapshot.target)}-${Date.now()}-${shortRand()}.json`,
    );
    const resultPath = `${snapshotPath}.result.json`;

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    const librarianHandle = librarianHandleFor(snapshot);
    const preExisting = personaExists(runtime.paths, librarianHandle);
    const prompt = await renderLibrarianPrompt({
      snapshot,
      snapshotPath,
      resultPath,
    });

    await runtime.spawn({
      username: librarianHandle,
      project: runtime.defaultProject,
      cwd: runtime.defaultCwd,
      platform: runtime.defaultPlatform,
      prompt,
      preExisting,
    });

    const result = await pollForResult(resultPath, {
      timeout_ms: timeoutMs,
      interval_ms: pollInterval,
    });
    return result;
  }
}

function personaExists(paths: Paths, username: string): boolean {
  const personaPath = path.join(paths.dataDir, "personas", `${username}.json`);
  try {
    return fs.statSync(personaPath).isFile();
  } catch {
    return false;
  }
}

/** Build the librarian's initial prompt. Prepends the librarian-skill
 * markdown (loaded from disk) and appends a task-specific section
 * naming the target + snapshot path + result path. */
export async function renderLibrarianPrompt(input: {
  snapshot: LibrarianSnapshot;
  snapshotPath: string;
  resultPath: string;
}): Promise<string> {
  const skill = await readFile(LIBRARIAN_SKILL_PATH, "utf8");
  const shown = input.snapshot.entries.length;
  const total = input.snapshot.total_candidates ?? shown;
  const entriesLine =
    shown < total
      ? `- **Entries in snapshot**: ${shown} of ${total} — a stalest-first slice (faded entries, then oldest active). The remaining ${total - shown} are deferred to the next dream pass by design; you are not missing them by mistake and do not need to account for them.`
      : `- **Entries in snapshot**: ${shown}`;
  return [
    skill,
    "",
    "---",
    "",
    "## This pass",
    "",
    `- **Scope**: ${input.snapshot.scope}`,
    `- **Target**: ${input.snapshot.target}`,
    entriesLine,
    `- **Snapshot file**: ${input.snapshotPath}`,
    `- **Result file** (write here when done): ${input.resultPath}`,
    "",
    "Start by reading the snapshot file, then proceed per the instructions above.",
  ].join("\n");
}

interface PollOptions {
  timeout_ms: number;
  interval_ms: number;
}

/** Poll for the result file. Returns the parsed + validated payload
 * once it appears. Throws DreamError on timeout, schema failure, or
 * malformed JSON. */
async function pollForResult(
  resultPath: string,
  opts: PollOptions,
): Promise<DreamApplyResult> {
  const deadline = Date.now() + opts.timeout_ms;
  while (Date.now() < deadline) {
    let stats;
    try {
      stats = await stat(resultPath);
    } catch {
      stats = null;
    }
    if (stats && stats.size > 0) {
      try {
        const raw = await readFile(resultPath, "utf8");
        const parsed = JSON.parse(raw);
        const errors = validatePayload(parsed, LIBRARIAN_RESULT_SCHEMA);
        if (errors.length > 0) {
          throw new DreamError(
            "invalid_plan",
            `Librarian result file failed schema validation: ${errors
              .slice(0, 5)
              .map((e) => `${e.path || "/"} — ${e.message}`)
              .join("; ")}`,
            { errors, resultPath },
          );
        }
        const r = parsed as Record<string, unknown>;
        return {
          scope: r.scope as DreamScope,
          target: r.target as string,
          faded: r.faded as number,
          forgotten: r.forgotten as number,
          consolidated: r.consolidated as number,
          audit_entry_id: (r.audit_entry_id as string | undefined) ?? "",
          notes: (r.notes as string[] | undefined) ?? [],
        };
      } catch (err) {
        if (err instanceof DreamError) throw err;
        if (err instanceof SyntaxError) {
          // Partial write — keep polling.
        } else {
          throw err;
        }
      }
    }
    await delay(opts.interval_ms);
  }
  throw new DreamError(
    "librarian_timeout",
    `Librarian result file did not appear within ${opts.timeout_ms}ms — librarian may have crashed or be still working.`,
    { resultPath },
  );
}

/** Persona handle for the librarian. Persona scope uses the target
 * username verbatim; project scope uses the project name. */
export function librarianHandleFor(snapshot: LibrarianSnapshot): string {
  return `librarian-${snapshot.target}`;
}

/** Cleanup: prune snapshot + result pairs older than `maxAgeMs`.
 * Called from the dream handler (or a daemon-tick) to keep the inbox
 * bounded. Files newer than the cutoff stay for forensics. */
export async function pruneDreamInbox(
  paths: Paths,
  maxAgeMs: number,
): Promise<{ removed: number }> {
  const inbox = path.join(paths.stateDir, "dream", "inbox");
  let removed = 0;
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(inbox, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  const now = Date.now();
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const full = path.join(inbox, d.name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (now - s.mtimeMs > maxAgeMs) {
      try {
        await fs.promises.unlink(full);
        removed++;
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  return { removed };
}

function shortRand(): string {
  return crypto.randomBytes(3).toString("hex");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
