/** `dream` MCP handler — invoke the librarian and apply the plan.
 *
 * scope = "persona" → operate on the calling persona's memory.
 * scope = "project" → operate on the caller's project memory.
 * scope = "both"    → run both, return a combined summary.
 *
 * The librarian is a Sonnet 4.6 subagent run via `claude -p`. Active +
 * faded entries are passed in full; forgotten entries are omitted
 * (they were forgotten for a reason). Plan is applied auto — no
 * review step.
 *
 * Cost cap: one auto-triggered dream per scope per 24h, enforced via
 * the most recent `kind: "dream_log"` entry's date. Manual calls pass
 * `force: true` to bypass. */

import {
  ClaudeCliLibrarian,
  applyPersonaPlan,
  applyProjectPlan,
  buildPersonaSnapshot,
  buildProjectSnapshot,
  type DreamApplyResult,
  type Librarian,
} from "../../dream/index.ts";
import { listIndex } from "../../memory/index.ts";
import { listProjectIndex } from "../../project-memory/index.ts";
import {
  asBoolean,
  asNumber,
  asString,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Module-private librarian factory — tests override it via
 * `setLibrarian` to inject a fake without spawning subprocesses. */
let currentLibrarian: Librarian = new ClaudeCliLibrarian();

export function setLibrarian(next: Librarian): void {
  currentLibrarian = next;
}

export function resetLibrarian(): void {
  currentLibrarian = new ClaudeCliLibrarian();
}

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

export const dream: Handler = async (args, ctx) => {
  const scope = resolveScope(args);
  const force = asBoolean(args.force) ?? false;
  const timeout_ms = asNumber(args.timeout_ms);

  const librarianOpts: Parameters<Librarian["run"]>[1] =
    timeout_ms !== undefined ? { timeout_ms } : {};

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
      const snapshot = buildPersonaSnapshot(ctx.paths, username);
      const plan = await currentLibrarian.run(snapshot, librarianOpts);
      results.push(applyPersonaPlan(ctx.paths, username, plan));
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
      const snapshot = buildProjectSnapshot(ctx.paths, project);
      const plan = await currentLibrarian.run(snapshot, librarianOpts);
      const author = ctx.session.claimedUsername ?? null;
      results.push(applyProjectPlan(ctx.paths, project, plan, author));
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
