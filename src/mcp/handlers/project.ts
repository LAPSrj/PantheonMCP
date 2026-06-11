/** Project policy MCP handlers.
 *
 * `list_projects_any` — enumerate every known project (union of on-disk
 * `projects/<name>/` dirs + distinct persona `project` fields) with its
 * agent count, single-agent flag, and optional description. Listing is
 * inherently cross-project, so there is no bare variant — only the
 * `_any` form (which the single-agent tool-surface trim hides, like the
 * other `_any` reads).
 *
 * `edit_project` / `edit_project_any` — set a project's `description`
 * and/or its `single_agent` lock. Bare variant edits the CALLER's
 * current project (resolved from chat login); `_any` takes an explicit
 * `project`. Single-agent is a guarded policy knob — see the tool
 * description: flip it ONLY with the user's express authorization. */

import {
  listProjectDirNames,
  readProjectConfig,
  setProjectDescription,
  setProjectSingleAgent,
  assertValidProjectName,
  MAX_PROJECT_DESCRIPTION,
} from "../../storage/index.ts";
import {
  listPersonas,
  assertSingleAgentLockable,
  IdentityError,
} from "../../identity/index.ts";
import {
  asBoolean,
  asStringRequired,
  type Handler,
  type HandlerContext,
  ToolError,
} from "../types.ts";

function resolveCurrentProject(ctx: HandlerContext): string {
  if (ctx.chat && ctx.chat_agent_id) {
    const project = ctx.chat.getSubscriberProject(ctx.chat_agent_id);
    if (project) return project;
  }
  throw new ToolError(
    "no_project_scope",
    "edit_project needs a project scope. Log into chat first, or use edit_project_any with an explicit `project`.",
  );
}

function validProject(project: string): string {
  try {
    return assertValidProjectName(project);
  } catch (err) {
    throw new ToolError("invalid_project", (err as Error).message);
  }
}

// ---------------------------------------------------------------- //
// list_projects_any
// ---------------------------------------------------------------- //

function doListProjects(ctx: HandlerContext) {
  // Agent count per project, computed in one registry pass.
  const counts = new Map<string, number>();
  for (const p of listPersonas(ctx.paths)) {
    counts.set(p.project, (counts.get(p.project) ?? 0) + 1);
  }
  // Union: every project with personas + every project with on-disk state.
  const names = new Set<string>(counts.keys());
  for (const name of listProjectDirNames(ctx.paths)) names.add(name);

  const projects = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const cfg = readProjectConfig(ctx.paths, name);
      return {
        name,
        agent_count: counts.get(name) ?? 0,
        single_agent: cfg.single_agent === true,
        ...(cfg.description ? { description: cfg.description } : {}),
      };
    });
  return { count: projects.length, projects };
}

// ---------------------------------------------------------------- //
// edit_project / edit_project_any
// ---------------------------------------------------------------- //

function doEditProject(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  project: string,
) {
  validProject(project);

  // `description`: absent = leave as-is; null/"" = clear; string = set.
  const hasDescription = "description" in args;
  const descRaw = args.description;
  if (hasDescription && descRaw !== null && typeof descRaw !== "string") {
    throw new ToolError(
      "invalid_argument",
      "'description' must be a string (≤160 chars) or null to clear.",
    );
  }
  const single_agent = asBoolean(args.single_agent);

  if (!hasDescription && single_agent === undefined) {
    throw new ToolError(
      "nothing_to_edit",
      "Pass `description` and/or `single_agent` — nothing to edit.",
    );
  }

  const before = readProjectConfig(ctx.paths, project);
  const changed: string[] = [];

  if (hasDescription) {
    try {
      setProjectDescription(ctx.paths, project, descRaw as string | null);
    } catch (err) {
      throw new ToolError("description_too_long", (err as Error).message, {
        max: MAX_PROJECT_DESCRIPTION,
      });
    }
    changed.push("description");
  }

  let single_agent_effect: string | undefined;
  if (single_agent !== undefined) {
    const wasOn = before.single_agent === true;
    // Enabling the lock requires the project to already hold ≤1 persona.
    if (single_agent && !wasOn) {
      try {
        assertSingleAgentLockable(ctx.paths, project);
      } catch (err) {
        if (err instanceof IdentityError) {
          throw new ToolError(err.code, err.message, err.extra);
        }
        throw err;
      }
    }
    setProjectSingleAgent(ctx.paths, project, single_agent);
    if (single_agent !== wasOn) changed.push("single_agent");
    single_agent_effect = single_agent
      ? "enabled — effective IMMEDIATELY: the persona-creation lock is read live, so the next register/summon/fork in this project is refused at once. (Sessions already running keep their current tool surface until they restart.)"
      : "disabled — effective for NEW sessions only: sessions already running under the lock keep the trimmed single-agent tool surface until they restart.";
  }

  const after = readProjectConfig(ctx.paths, project);
  return {
    project,
    changed,
    single_agent: after.single_agent === true,
    ...(after.description ? { description: after.description } : {}),
    ...(single_agent_effect ? { single_agent_effect } : {}),
  };
}

// ---------------------------------------------------------------- //
// Public handlers
// ---------------------------------------------------------------- //

export const list_projects_any: Handler = async (_args, ctx) =>
  doListProjects(ctx);

export const edit_project: Handler = async (args, ctx) =>
  doEditProject(args, ctx, resolveCurrentProject(ctx));

export const edit_project_any: Handler = async (args, ctx) =>
  doEditProject(args, ctx, validProject(asStringRequired(args.project, "project")));
