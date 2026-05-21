import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PERMISSION_MODE,
  IdentityError,
  PERMISSION_MODES,
  createPersona,
  readPersona,
  stampSummoned,
  type PermissionMode,
} from "../../identity/index.ts";
import {
  decideNextSplit,
  ensureCwdTrusted,
  executeSpawnPlan,
  freshTab,
  getTabGeometry,
  getWindowState,
  paneCount,
  predictNextTabIndex,
  recordSpawn,
  resolveSpawnPlan,
  type SpawnArgs,
  type SpawnTarget,
  type SplitDecision,
  type TabGeometry,
} from "../../launcher/index.ts";
import { buildSummonBootstrap } from "../../responses/bootstrap.ts";
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
  // Resume cascade: caller arg wins; otherwise honor `persona.mode`
  // ("resume" personas auto-resume on every summon, "fresh" personas
  // start clean). Without this fallback, `persona.mode = "resume"`
  // was a label with no effect — agents had to remember to pass
  // `resume: true` every time.
  const resume = asBoolean(args.resume) ?? (persona.mode === "resume");
  const target = asObject(args.target) as SpawnTarget | undefined;
  const restTimeoutRaw = args.rest_timeout;
  const restTimeout: number | "never" = parseRestTimeout(restTimeoutRaw);

  // Build the exec command from the persona profile.
  const launchCommand = persona.launch_command || "claude";
  const launchArgs = [...(persona.launch_args ?? [])];

  // Profile passthrough — per-call args.profile becomes
  // `--profile=<value>` on the spawned `claude`. Pantheon doesn't
  // interpret the value; the launcher binds the matching credentials.
  // `confirm_new_profile` flows through as a bare `--confirm-new-profile`
  // flag the launcher requires before creating a new profile dir.
  const profile = asString(args.profile);
  if (profile) launchArgs.push(`--profile=${profile}`);
  if (asBoolean(args.confirm_new_profile)) launchArgs.push("--confirm-new-profile");

  // Channels passthrough — per-call args.channels (when supplied)
  // overrides persona.channels. Each value becomes one
  // `--channels <value>` flag on the spawned `claude`.
  const channelsArg = asStringArray(args.channels);
  const effectiveChannels = channelsArg ?? persona.channels ?? [];
  for (const channel of effectiveChannels) {
    launchArgs.push("--channels", channel);
  }

  // Remote-control passthrough — per-call args.remote_control overrides
  // persona.remote_control. `true` (or persona-default) → use persona.project
  // as the RC name; a string value is taken verbatim. `false` (or omitted
  // both per-call and on persona) → no flag.
  const rcResolved = resolveRemoteControl(args.remote_control, persona);
  if (rcResolved !== null) {
    launchArgs.push("--remote-control", rcResolved);
  }

  // Permission-mode cascade — per-call > persona.permission_mode >
  // PANTHEON_DEFAULT_PERMISSION_MODE env > "acceptEdits" floor.
  // Forwarded as `--permission-mode <value>` so the spawned `claude`
  // starts in the desired mode (e.g. `acceptEdits` shows "accept
  // edits on" in the prompt bar — no Shift+Tab keystroke needed).
  const permissionMode = resolvePermissionMode(
    args.permission_mode,
    persona,
    ctx.spawn_env,
  );
  launchArgs.push("--permission-mode", permissionMode);

  // Model cascade: per-call arg > persona.model > no flag (machine default).
  const model = resolveModel(args.model, persona);
  if (model) launchArgs.push("--model", model);

  if (resume && persona.resume_session_id) {
    launchArgs.push("--resume", persona.resume_session_id);
  }

  const summonerHandle = ctx.session.claimedUsername ?? ctx.summoner_username;

  // Bootstrap prompt: identity + chat-login + watcher + memory + status.
  // Without this, spawned agents have no instruction to log into chat or
  // start the watcher, so they appear in their tab but stay invisible to
  // peers — broke feature parity with summon-mcp's startup-prompt.
  // The runtime prompt (if any) appears under a separator after the
  // bootstrap; an empty runtime prompt yields a placeholder line so the
  // template's structure stays consistent.
  const chatSuffix = asString(args.chat_username_suffix);
  // Remanifest passthrough — see `remanifest` handler. The prelude is
  // rendered above the standard bootstrap text; the env var is what
  // the new pantheon process reads to write the old's exit signal.
  const remanifestHandoff = asString(args.remanifest_handoff);
  const remanifestOf = asString(args.remanifest_of);
  const bootstrap = buildSummonBootstrap(persona, {
    runtime_prompt: prompt,
    summoner_username: summonerHandle ?? null,
    rest_timeout: restTimeout,
    ...(chatSuffix !== undefined ? { chat_username_suffix: chatSuffix } : {}),
    ...(remanifestHandoff !== undefined ? { remanifest_handoff: remanifestHandoff } : {}),
  });
  launchArgs.push(bootstrap);
  const tabTitle = `${persona.username}${persona.session_name ? ` (${persona.summon_count + 1})` : ""}`;
  const windowName = target?.window ?? `summon-${persona.username}`;
  // Predict the tab_index the new spawn will land on so the spawned
  // MCP server can record it for `exit`-time decrement.
  //
  // Default depends on mode:
  //   - split-pane → the LAST EXISTING tab (max(0, tabCount-1)). The
  //     spawn lands INSIDE an existing tab; the prior off-by-one used
  //     `predictNextTabIndex` (= count, not last-index), which made
  //     every split think it was a brand-new tab. That's the bug
  //     semaphoremole repro'd at n=3 [[0],[1],[2]].
  //   - new-tab modes → predictNextTabIndex (= current tabCount, the
  //     index wt will assign when it creates the new tab).
  // Best-effort either way; the user can close tabs externally.
  const isSplitMode = (target?.mode ?? "") === "split-pane";
  let predictedTabIndex: number;
  if (target?.tab_index !== undefined) {
    predictedTabIndex = target.tab_index;
  } else if (isSplitMode) {
    const wstate = getWindowState(ctx.paths, windowName);
    predictedTabIndex = Math.max(0, (wstate?.tabCount ?? 1) - 1);
  } else {
    predictedTabIndex = predictNextTabIndex(ctx.paths, windowName);
  }

  // Per-spawn graceful-exit sentinel. The spawned MCP server's exit
  // scheduler (server.ts:makeRealExitScheduler) writes this file
  // immediately before SIGTERM-ing the parent CC process. The wt
  // adapter's bash launch script reads it: when the inner process
  // exits 143 AND the sentinel exists, the script remaps to exit 0 so
  // wt's `closeOnExit: graceful` actually closes the tab. External
  // SIGTERMs (OOM, manual `kill`, system shutdown) leave the sentinel
  // absent and the tab stays open with the visible 143, which is the
  // intended diagnostic behavior.
  //
  // Always set; non-wt adapters and native-Windows wt simply ignore
  // it. Tmpfile leak is bounded — the wrapper rm's it on the success
  // path; pantheon's stop hooks / future cleanup pass can sweep
  // `os.tmpdir()/pantheon-exit-*` if it ever drifts.
  const exitSentinelPath = path.join(
    os.tmpdir(),
    `pantheon-exit-${process.pid}-${crypto.randomUUID()}`,
  );

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
    PANTHEON_EXIT_SENTINEL: exitSentinelPath,
  };
  // Color export so the spawned MCP can echo it via session_info.
  if (persona.color) execEnv.PANTHEON_COLOR = persona.color;
  // Self-exit gate. When set, the spawned agent's `rest`, `exit`,
  // and `logout` handlers reject with `self_exit_blocked`. The only
  // ways to end the session are then (a) watchdog rest_timeout
  // firing, or (b) any peer calling `force_rest` / `force_exit`
  // (which writes a rest_requests row that the spawned process's
  // prune tick consumes). Default off.
  if (asBoolean(args.block_self_exit)) execEnv.PANTHEON_BLOCK_SELF_EXIT = "1";
  // Remanifest: when the OLD session is spawning the NEW one, set the
  // old's chat agent_id so the new's first successful login writes a
  // rest_requests(exit) row addressed to the old. The old's prune-tick
  // consumes the row and closes its tab. Without an explicit env var,
  // pantheon has no way to thread "kill the previous incarnation"
  // across two processes that share nothing but the SQLite db.
  if (remanifestOf) execEnv.PANTHEON_REMANIFEST_OF = remanifestOf;
  // Also surface the handoff text in env so the bootstrap path
  // (provisional / agent re-reading on a /compact) can re-render it
  // even after the initial bootstrap is gone from CC's context.
  if (remanifestHandoff) execEnv.PANTHEON_REMANIFEST_HANDOFF = remanifestHandoff;
  // Profile preservation — persist the per-call `--profile` so a later
  // `remanifest` of this agent can recover and re-thread it. Without
  // this, the per-call profile lives only in `launchArgs` (consumed by
  // the wrapper at exec time) and is invisible to the spawned process;
  // a remanifest then drops `--profile`, loses CLAUDE_CONFIG_DIR, and
  // silently relaunches under the default ~/.claude account.
  if (profile) execEnv.PANTHEON_PROFILE = profile;

  // WSL targets need the wt adapter to wrap exec in `wsl.exe -d
  // <distro> -- bash -lc 'cd <cwd> && exec ...'` (see wt.ts notes
  // for the wt.exe error 0x8007010b background). Detect: persona
  // platform == "wsl" with a wsl_distro field set.
  const wslDistro =
    persona.platform === "wsl" ? (persona.wsl_distro ?? ctx.spawn_env.WSL_DISTRO_NAME) : undefined;

  // Pane-geometry policy. For split-pane spawns we read the per-tab
  // geometry, decide where the next pane lands (direction +
  // target_pane_id), and pass the resolution into SpawnArgs. The wt
  // adapter renders `focus-pane -t <id> ; split-pane -V|-H` from those
  // fields. Caller-explicit `target.split` still wins on direction;
  // the focus pane stays policy-chosen so even an explicit-direction
  // split lands in the right place. Non-split spawns (new-tab,
  // new-window) skip this entirely.
  const currentGeometry: TabGeometry | null = isSplitMode
    ? (getTabGeometry(ctx.paths, windowName, predictedTabIndex) ?? freshTab())
    : null;
  const splitDecision: SplitDecision | null =
    isSplitMode && currentGeometry ? decideNextSplit(currentGeometry) : null;

  const resolvedTarget: SpawnTarget = { ...(target ?? {}), window: windowName };
  if (splitDecision) {
    // Don't clobber a caller-explicit split direction; honor policy
    // when the caller didn't specify.
    if (resolvedTarget.split === undefined) {
      resolvedTarget.split = splitDecision.direction === "V" ? "vertical" : "horizontal";
    }
    if (resolvedTarget.focus_pane_id === undefined) {
      resolvedTarget.focus_pane_id = splitDecision.target_pane_id;
    }
  }

  const spawnArgs: SpawnArgs = {
    exec_command: launchCommand,
    exec_args: launchArgs,
    exec_env: execEnv,
    cwd: persona.cwd,
    tab_title: tabTitle,
    ...(persona.color ? { color: persona.color } : {}),
    ...(persona.wt_profile !== undefined && persona.wt_profile !== null
      ? { wt_profile: persona.wt_profile }
      : {}),
    target: resolvedTarget,
    ...(wslDistro !== undefined ? { wsl_distro: wslDistro } : {}),
    existing_pane_count: currentGeometry ? paneCount(currentGeometry) : 0,
  };

  const plan = resolveSpawnPlan(spawnArgs, { env: ctx.spawn_env });

  // Best-effort: mark the persona's cwd as trusted in ~/.claude.json
  // BEFORE spawning so a fresh `claude` launch doesn't block on the
  // first-time trust prompt. Failures land in stamp_warnings; the spawn
  // proceeds either way (the user can hit "Yes, trust" manually).
  const trustResult = ensureCwdTrusted(persona.cwd, {
    claudeJsonPath: ctx.claude_config_path,
  });

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
  if (trustResult.warning) stampWarnings.push(trustResult.warning);
  try {
    recordSpawn(ctx.paths, windowName, {
      summoner: summonerHandle ?? null,
      persona: persona.username,
      ...(target?.tab_index !== undefined ? { tab_index: target.tab_index } : {}),
      mode: plan.resolved_mode === "split-pane" ? "split-pane"
        : plan.resolved_mode === "new-window" ? "new-window"
        : "new-tab",
      // For split-pane, persist the EXACT decision the wt adapter
      // emitted so the next spawn into this tab walks from the correct
      // post-split state. For non-split spawns (new-tab/new-window),
      // recordSpawn seeds a fresh single-pane TabGeometry — no
      // decision needed.
      ...(plan.resolved_mode === "split-pane" && splitDecision
        ? { decision: splitDecision }
        : {}),
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
    trust: {
      path: trustResult.path,
      trusted_now: trustResult.trusted_now,
      trusted_already: trustResult.trusted_already,
    },
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

/** Resolve the effective remote-control name for a spawn.
 *
 * Returns the RC name to pass as `--remote-control "<name>"`, or
 * `null` to omit the flag entirely.
 *
 * Resolution order:
 *   1. Per-call `args.remote_control` is a string → use it.
 *   2. Per-call `args.remote_control === true` → persona.project.
 *   3. Per-call `args.remote_control === false` → no flag (explicit off).
 *   4. Per-call omitted, `persona.remote_control === true` → persona.project.
 *   5. Otherwise → no flag.
 */
function resolveRemoteControl(raw: unknown, persona: Persona): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw === true) return persona.project;
  if (raw === false) return null;
  if (persona.remote_control === true) return persona.project;
  return null;
}

function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);
}

/** Resolve the effective permission mode for a spawn:
 *   1. caller-supplied `args.permission_mode`
 *   2. `persona.permission_mode`
 *   3. `PANTHEON_DEFAULT_PERMISSION_MODE` env on the spawning MCP
 *   4. `DEFAULT_PERMISSION_MODE` floor (`"acceptEdits"`)
 *
 * Invalid values at any layer fall through silently to the next layer
 * — better to ship the agent with the floor than to error a summon. */
function resolvePermissionMode(
  raw: unknown,
  persona: Persona,
  env: NodeJS.ProcessEnv,
): PermissionMode {
  if (isPermissionMode(raw)) return raw;
  if (persona.permission_mode != null && isPermissionMode(persona.permission_mode)) {
    return persona.permission_mode;
  }
  const envDefault = env.PANTHEON_DEFAULT_PERMISSION_MODE;
  if (isPermissionMode(envDefault)) return envDefault;
  return DEFAULT_PERMISSION_MODE;
}

function resolveModel(raw: unknown, persona: Persona): string | null {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof persona.model === "string" && persona.model.trim().length > 0) return persona.model.trim();
  return null;
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
    ...(asStringArray(args.channels) !== undefined
      ? { channels: asStringArray(args.channels)! }
      : {}),
    ...(asBoolean(args.remote_control) !== undefined
      ? { remote_control: asBoolean(args.remote_control)! }
      : {}),
    ...(isPermissionMode(args.permission_mode)
      ? { permission_mode: args.permission_mode }
      : {}),
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
      ...(asString(args.model) !== undefined ? { model: asString(args.model) } : {}),
      ...(asString(args.profile) !== undefined ? { profile: asString(args.profile) } : {}),
      ...(asBoolean(args.confirm_new_profile) !== undefined ? { confirm_new_profile: asBoolean(args.confirm_new_profile) } : {}),
      ...(asBoolean(args.block_self_exit) !== undefined ? { block_self_exit: asBoolean(args.block_self_exit) } : {}),
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
