import {
  IdentityError,
  createPersona,
  readPersona,
  stampSummoned,
} from "../../identity/index.ts";
import {
  executeSpawnPlan,
  predictNextTabIndex,
  recordSpawn,
  resolveSpawnPlan,
  type SpawnArgs,
  type SpawnTarget,
} from "../../launcher/index.ts";
import { DEFAULT_REST_TIMEOUT_SECONDS } from "../../watchdog/index.ts";
import {
  asBoolean,
  asNumber,
  asObject,
  asString,
  asStringArray,
  asStringRequired,
  ToolError,
  type Handler,
  type HandlerContext,
} from "../types.ts";
import type { Persona } from "../../identity/index.ts";

interface SummonOptions {
  /** Cross-project gate: when true, do NOT enforce caller-project ===
   * target-project. summon → false; summon_any → true. */
  any_project: boolean;
}

async function performSummon(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  opts: SummonOptions,
): Promise<unknown> {
  const username = asStringRequired(args.username, "username");
  const persona = readPersona(ctx.paths, username);
  if (!persona) {
    throw new IdentityError(
      "not_registered",
      `Cannot summon '${username}' — no registration found.`,
    );
  }

  if (!opts.any_project) {
    enforceSameProject(ctx, persona);
  }

  return spawnPersona(args, ctx, persona);
}

function enforceSameProject(ctx: HandlerContext, target: Persona): void {
  const claimed = ctx.session.claimedUsername;
  if (!claimed) return; // Pre-claim summons (e.g. early bootstrap) bypass.
  const me = readPersona(ctx.paths, claimed);
  if (!me) return;
  if (me.project !== target.project) {
    throw new ToolError(
      "cross_project_blocked",
      `summon refuses cross-project spawn: you are in '${me.project}', target '${target.username}' is in '${target.project}'. Use summon_any if intentional.`,
      { caller_project: me.project, target_project: target.project },
    );
  }
}

/** Exported so the CLI (`pantheon summon`) can call the same code
 * path the MCP `summon` handler uses. The args shape mirrors the
 * MCP tool's input — Record<string, unknown> with `prompt`,
 * `resume`, `target`, `rest_timeout` keys. */
export async function spawnPersona(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  persona: Persona,
): Promise<unknown> {
  const prompt = asString(args.prompt) ?? "";
  const resume = asBoolean(args.resume) ?? false;
  const target = asObject(args.target) as SpawnTarget | undefined;
  const restTimeoutRaw = args.rest_timeout;
  const restTimeout: number | "never" = parseRestTimeout(restTimeoutRaw);

  // Build the exec command from the persona profile.
  const launchCommand = persona.launch_command || "claude";
  const launchArgs = [...(persona.launch_args ?? [])];
  if (resume && persona.resume_session_id) {
    launchArgs.push("--resume", persona.resume_session_id);
  }
  if (prompt) {
    launchArgs.push(prompt);
  }

  const summonerHandle = ctx.session.claimedUsername ?? ctx.summoner_username;
  const tabTitle = `${persona.username}${persona.session_name ? ` (${persona.summon_count + 1})` : ""}`;
  const windowName = target?.window ?? `summon-${persona.username}`;
  // Predict the tab_index the new spawn will land on so the spawned
  // MCP server can record it for `exit`-time decrement. Best-effort —
  // the user can close tabs manually and shift the actual layout.
  const predictedTabIndex = target?.tab_index ?? predictNextTabIndex(ctx.paths, windowName);

  const execEnv: Record<string, string> = {
    PANTHEON_SUMMONED: "1",
    PANTHEON_USERNAME: persona.username,
    ...(summonerHandle ? { PANTHEON_SUMMONER: summonerHandle } : {}),
    // Informational only per the §14 single-timer rule. The spawned
    // MCP server reads this to display "rest in Xmin" in its startup
    // banner; it does NOT arm its own watchdog timer from this value.
    // Authoritative timer lives in the daemon (this process today;
    // future dedicated daemon).
    PANTHEON_REST_TIMEOUT: String(restTimeout),
    PANTHEON_WINDOW_NAME: windowName,
    PANTHEON_TAB_INDEX: String(predictedTabIndex),
  };
  // Color export so the spawned MCP can echo it via session_info.
  if (persona.color) execEnv.PANTHEON_COLOR = persona.color;

  const spawnArgs: SpawnArgs = {
    exec_command: launchCommand,
    exec_args: launchArgs,
    exec_env: execEnv,
    cwd: persona.cwd,
    tab_title: tabTitle,
    ...(persona.color ? { color: persona.color } : {}),
    target: { ...(target ?? {}), window: windowName },
  };

  const plan = resolveSpawnPlan(spawnArgs, { env: ctx.spawn_env });
  const exec = await executeSpawnPlan(plan, {
    executor: ctx.spawn_executor,
    stderr_probe_ms: ctx.stderr_probe_ms,
  });

  // §11a edge case: split-pane spawn that captured stderr from the
  // probe failed silently in the host terminal. Surface as
  // spawn_failed so the caller knows the tab wasn't created.
  if (plan.requires_stderr_probe && exec.stderr_warning) {
    throw new ToolError(
      "spawn_failed",
      `Spawn for '${persona.username}' produced stderr during the 200ms probe: ${exec.stderr_warning}`,
      {
        persona: persona.username,
        adapter: plan.adapter,
        resolved_mode: plan.resolved_mode,
        stderr: exec.stderr_warning,
      },
    );
  }

  // Best-effort registry / stamps. Failures here do not roll back the
  // spawn — the user already has a tab open. Surface the error in the
  // response if it actually trips.
  const stampWarnings: string[] = [];
  try {
    recordSpawn(ctx.paths, windowName, {
      summoner: summonerHandle ?? null,
      persona: persona.username,
      ...(target?.tab_index !== undefined ? { tab_index: target.tab_index } : {}),
    });
  } catch (err) {
    stampWarnings.push(`window_registry: ${(err as Error).message}`);
  }
  try {
    stampSummoned(ctx.paths, persona.username);
  } catch (err) {
    stampWarnings.push(`stamp_summoned: ${(err as Error).message}`);
  }

  // §14 single-timer: the summoner does NOT arm a tracking watchdog
  // here. Two timers in two processes for one logical session is
  // divergence territory. The spawned MCP server's daemon owns its
  // own session watchdog; activity flows in via that process's MCP
  // requests. When the dedicated-daemon model lands, the daemon
  // takes over both halves and the spawned process drops its timer.

  return {
    ok: true,
    summoned: persona.username,
    project: persona.project,
    cwd: persona.cwd,
    mode: resume ? "resume" : (persona.mode ?? "fresh"),
    plan_description: plan.description,
    spawn_pid: exec.pid ?? null,
    tab_title: tabTitle,
    color: persona.color ?? null,
    resolved_mode: plan.resolved_mode,
    adapter: plan.adapter,
    rest_timeout: restTimeout,
    ...(plan.downgrade_note ? { note: plan.downgrade_note } : {}),
    ...(exec.stderr_warning ? { spawn_stderr: exec.stderr_warning } : {}),
    ...(stampWarnings.length > 0 ? { stamp_warnings: stampWarnings } : {}),
  };
}

function parseRestTimeout(raw: unknown): number | "never" {
  if (raw === "never") return "never";
  const n = asNumber(raw);
  if (n === undefined) return DEFAULT_REST_TIMEOUT_SECONDS;
  return n;
}

export const summon: Handler = (args, ctx) => performSummon(args, ctx, { any_project: false });
export const summon_any: Handler = (args, ctx) => performSummon(args, ctx, { any_project: true });

interface ConjureOptions {
  any_project: boolean;
}

async function performConjure(
  args: Record<string, unknown>,
  ctx: HandlerContext,
  opts: ConjureOptions,
): Promise<unknown> {
  const username = asStringRequired(args.username, "username");
  const cwd = asStringRequired(args.cwd, "cwd");
  const project = asStringRequired(args.project, "project");
  const prompt = asStringRequired(args.prompt, "prompt");
  const platform = (asString(args.platform) as never) ?? ctx.platform;

  if (!opts.any_project) {
    const claimed = ctx.session.claimedUsername;
    if (claimed) {
      const me = readPersona(ctx.paths, claimed);
      if (me && me.project !== project) {
        throw new ToolError(
          "cross_project_blocked",
          `conjure refuses cross-project create: you are in '${me.project}', conjuring into '${project}'. Use conjure_any if intentional.`,
          { caller_project: me.project, target_project: project },
        );
      }
    }
  }

  // Atomic register-then-spawn. The persona is provisional until the
  // spawned agent's first update_profile fills in description+expertise+owns.
  const persona = createPersona(ctx.paths, {
    username,
    project,
    cwd,
    platform,
    ...(asString(args.wsl_distro) !== undefined ? { wsl_distro: asString(args.wsl_distro)! } : {}),
    ...(asString(args.launch_command) !== undefined
      ? { launch_command: asString(args.launch_command)! }
      : {}),
    ...(asStringArray(args.launch_args) !== undefined
      ? { launch_args: asStringArray(args.launch_args)! }
      : {}),
    ...(asString(args.color) !== undefined ? { color: asString(args.color) as never } : {}),
    ...(asString(args.mode) !== undefined ? { mode: asString(args.mode) as never } : {}),
    provisional: true,
  });

  // Forward to the summon path. If spawn fails after this point, the
  // persona stays registered (per semaphoremole — it's a valid
  // identity; the user can summon again).
  const result = (await spawnPersona(
    {
      username: persona.username,
      prompt,
      target: args.target,
      rest_timeout: args.rest_timeout,
    },
    ctx,
    persona,
  )) as Record<string, unknown>;

  return {
    ...result,
    conjured: true,
    provisional: true,
    bootstrap_required:
      "The new agent is provisional — its first action MUST be `update_profile({ description, expertise, owns })`. Until then, all other tools are blocked.",
  };
}

export const conjure: Handler = (args, ctx) => performConjure(args, ctx, { any_project: false });
export const conjure_any: Handler = (args, ctx) => performConjure(args, ctx, { any_project: true });
