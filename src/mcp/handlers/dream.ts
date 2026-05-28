/** `dream` MCP handler — orchestrates a memory-organization pass via
 * an ephemeral `librarian-<target>` agent.
 *
 * scope = "persona" → operate on the calling persona's memory.
 * scope = "project" → operate on the caller's project memory.
 * scope = "both"    → run both, return a combined summary.
 *
 * The librarian is conjured fresh per pass: it reads a snapshot file,
 * `become`s the target (persona scope), applies fades / forgets /
 * consolidates via MCP, writes a result file, and rests. The
 * lifecycle-rule coercion in `forget_memory` /
 * `forget_project_memory` protects core + active-reference entries
 * regardless of the librarian's intent — the data-layer invariant
 * holds even when the librarian misjudges.
 *
 * Cost cap: one auto-triggered dream per scope per 24h, enforced via
 * the most recent `kind: "dream_log"` entry's date. Manual calls pass
 * `force: true` to bypass. */

import {
  buildPersonaSnapshot,
  buildProjectSnapshot,
  type DreamApplyResult,
} from "../../dream/index.ts";
import {
  ConjuredLibrarian,
  type Librarian,
  type LibrarianSpawner,
} from "../../dream/conjured-librarian.ts";
import { listIndex } from "../../memory/index.ts";
import { listProjectIndex } from "../../project-memory/index.ts";
import {
  createPersona,
  readPersona,
  IdentityError,
} from "../../identity/index.ts";
import { spawnPersona } from "./spawn.ts";
import {
  asBoolean,
  asNumber,
  asString,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveScope(args: Record<string, unknown>): "persona" | "project" | "both" {
  const scope = asString(args.scope) ?? "persona";
  if (scope !== "persona" && scope !== "project" && scope !== "both") {
    throw new ToolError(
      "invalid_argument",
      `'scope' must be 'persona' | 'project' | 'both'.`,
    );
  }
  return scope;
}

function resolveCallerProject(ctx: HandlerContext): string {
  if (ctx.chat && ctx.chat_agent_id) {
    const project = ctx.chat.getSubscriberProject(ctx.chat_agent_id);
    if (project) return project;
  }
  throw new ToolError(
    "no_project_scope",
    "Dream(scope=project) needs a chat login — schemas/memory are project-scoped.",
  );
}

function resolveCallerUsername(ctx: HandlerContext): string {
  const username = ctx.session.claimedUsername;
  if (!username) {
    throw new ToolError(
      "no_persona",
      "Dream(scope=persona) needs a claimed persona.",
    );
  }
  return username;
}

function lastPersonaDreamTimestamp(
  ctx: HandlerContext,
  username: string,
): number | null {
  const recent = listIndex(ctx.paths, username, { kind: "dream_log" });
  if (recent.length === 0) return null;
  return Date.parse(recent[0]!.date);
}

function lastProjectDreamTimestamp(
  ctx: HandlerContext,
  project: string,
): number | null {
  const recent = listProjectIndex(ctx.paths, project, { kind: "dream_log" });
  if (recent.length === 0) return null;
  return Date.parse(recent[0]!.date);
}

/** Module-private librarian factory — tests override via
 * `setLibrarian` to inject a fake without spawning subprocesses. */
let currentLibrarian: Librarian = new ConjuredLibrarian();

export function setLibrarian(next: Librarian): void {
  currentLibrarian = next;
}

export function resetLibrarian(): void {
  currentLibrarian = new ConjuredLibrarian();
}

/** Build a real spawner closing over the handler context. Conjures
 * `librarian-<target>` on first use; summons existing persona on
 * subsequent passes. Librarian persona is created non-provisional so
 * it skips the `bootstrap_required` gate — its first action is to
 * read the snapshot, not call `update_profile`. */
function makeDefaultSpawner(ctx: HandlerContext): LibrarianSpawner {
  return async (input) => {
    if (!input.preExisting) {
      try {
        createPersona(ctx.paths, {
          username: input.username,
          project: input.project,
          cwd: input.cwd,
          platform: input.platform,
          description: "Ephemeral librarian — memory-organization passes only.",
          expertise: ["memory-organization", "dream-pass"],
          owns: [],
          provisional: false,
        });
      } catch (err) {
        if (err instanceof IdentityError && err.code === "username_taken_other_cwd") {
          // Pre-existing registration at a different cwd — fall through
          // and re-read; readPersona will return the existing entry.
        } else {
          throw err;
        }
      }
    }
    const persona = readPersona(ctx.paths, input.username);
    if (!persona) {
      throw new ToolError(
        "librarian_failed",
        `Failed to register or read librarian persona '${input.username}'.`,
      );
    }
    await spawnPersona(
      {
        username: persona.username,
        prompt: input.prompt,
      },
      ctx,
      persona,
      // Librarian subagent is a fire-and-forget memory pass; don't
      // boot-verify (it isn't a chat participant we retry).
      { verify: false },
    );
  };
}

export const dream: Handler = async (args, ctx) => {
  const scope = resolveScope(args);
  const force = asBoolean(args.force) ?? false;
  const timeout_ms = asNumber(args.timeout_ms);

  const librarianOpts = timeout_ms !== undefined ? { timeout_ms } : {};
  const librarian = currentLibrarian;
  const spawn = makeDefaultSpawner(ctx);

  const results: DreamApplyResult[] = [];
  const skipped: Array<{ scope: string; reason: string }> = [];

  if (scope === "persona" || scope === "both") {
    const username = resolveCallerUsername(ctx);
    const last = lastPersonaDreamTimestamp(ctx, username);
    if (!force && last !== null && Date.now() - last < DAY_MS) {
      skipped.push({
        scope: "persona",
        reason: `last dream was at ${new Date(last).toISOString()} — within the 24h cap. Pass force:true to override.`,
      });
    } else {
      const target = readPersona(ctx.paths, username);
      if (!target) {
        throw new ToolError(
          "no_persona",
          `Cannot snapshot memory for unregistered persona '${username}'.`,
        );
      }
      const snapshot = buildPersonaSnapshot(ctx.paths, username);
      const result = await librarian.run(
        snapshot,
        {
          paths: ctx.paths,
          defaultProject: target.project,
          defaultCwd: target.cwd,
          defaultPlatform: target.platform,
          spawn,
        },
        librarianOpts,
      );
      results.push(result);
    }
  }

  if (scope === "project" || scope === "both") {
    const project = resolveCallerProject(ctx);
    const last = lastProjectDreamTimestamp(ctx, project);
    if (!force && last !== null && Date.now() - last < DAY_MS) {
      skipped.push({
        scope: "project",
        reason: `last project-dream was at ${new Date(last).toISOString()} — within the 24h cap. Pass force:true to override.`,
      });
    } else {
      // For project scope, the librarian-<projectname> persona inherits
      // the caller's cwd + platform. The librarian operates on shared
      // project memory via the `_any` variants — no `become` step.
      const callerUsername = ctx.session.claimedUsername;
      const callerPersona = callerUsername
        ? readPersona(ctx.paths, callerUsername)
        : null;
      const cwd = callerPersona?.cwd ?? process.cwd();
      const platform = callerPersona?.platform ?? ctx.platform;
      const snapshot = buildProjectSnapshot(ctx.paths, project);
      const result = await librarian.run(
        snapshot,
        {
          paths: ctx.paths,
          defaultProject: project,
          defaultCwd: cwd,
          defaultPlatform: platform,
          spawn,
        },
        librarianOpts,
      );
      results.push(result);
    }
  }

  return {
    ok: true,
    scope,
    forced: force,
    applied: results,
    skipped,
  };
};
