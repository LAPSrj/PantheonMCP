/** `remanifest` MCP handler.
 *
 * The calling agent's context has gotten unwieldy (long /compact run,
 * working tree the agent no longer trusts, drift, etc.). Instead of
 * closing and re-summoning by hand, `remanifest` spawns a fresh
 * incarnation of the SAME persona into a NEW TAB of the SAME window
 * the calling session is in, passes a handoff text the new
 * incarnation will see in its first turn, and arranges for the OLD
 * session to close as soon as the new one has logged into chat. The
 * new session reclaims the canonical chat handle automatically once
 * the old's presence row is gone.
 *
 * Implementation reuses existing primitives:
 *
 *   1. spawnPersona spawns the new CC session with env vars
 *      PANTHEON_REMANIFEST_OF=<old_agent_id> +
 *      PANTHEON_REMANIFEST_HANDOFF=<text>.
 *   2. The new MCP process's chat `login` handler, on first
 *      successful claimed-persona login, sees PANTHEON_REMANIFEST_OF
 *      and writes a `rest_requests(target=<old>, kind=exit)` row.
 *   3. The OLD session's prune-tick consumes that row and runs its
 *      exit pipeline. Tab closes.
 *   4. The new session's prune-tick auto-reclaims the canonical
 *      handle once the old's presence row clears.
 *
 * Target shape is fixed: `mode: "new-tab-here"` always. Split-pane
 * and new-window are not reachable from remanifest (Leandro,
 * 2026-05-21). */

import { readPersona } from "../../identity/index.ts";
import { spawnPersona } from "./spawn.ts";
import {
  asString,
  asStringRequired,
  type Handler,
  type SpawnMetadata,
  ToolError,
} from "../types.ts";

/** Pure resolver: pick the spawn target shape for remanifest given
 * what we know about the calling session.
 *
 * Mode is ALWAYS `"new-tab-here"` — remanifest opens a new tab in
 * the SAME window as the calling session, never a new window and
 * never a split pane (Leandro 2026-05-21). The three branches below
 * differ only in HOW we identify "the same window":
 *
 *   1. Pantheon-spawned: `spawn_metadata.window_name` is the durable
 *      named window the agent was launched into. Target it directly
 *      → wt opens a new tab in the same named window.
 *   2. Windows Terminal session without spawn_metadata (manual
 *      start): target the user's CURRENT WT window via `-w 0`. The
 *      wt adapter resolves `window: "current"` → `-w 0` (most-
 *      recently-used window). Best-effort — when the user has the
 *      agent's tab focused at remanifest time this lands correctly;
 *      when focused elsewhere it opens in the wrong window. WT
 *      gives no per-session way to read "which window am I in"
 *      from inside, so MRU is the only signal available.
 *   3. Other adapters: mode-only, let the adapter pick its own
 *      "same window" semantics (tmux: same session; kitty: same OS
 *      window via --match; generic: spawn-in-place).
 *
 * Exported for unit testing — the truth table here is the spec. */
export function resolveRemanifestTarget(
  spawn_metadata: SpawnMetadata | null,
  spawn_env: NodeJS.ProcessEnv,
): { window?: string; mode: "new-tab-here" } {
  const oldWindowName = spawn_metadata?.window_name;
  if (oldWindowName) {
    return { window: oldWindowName, mode: "new-tab-here" };
  }
  if (spawn_env.WT_SESSION) {
    return { window: "current", mode: "new-tab-here" };
  }
  return { mode: "new-tab-here" };
}

export const remanifest: Handler = async (args, ctx) => {
  const handoff = asStringRequired(args.handoff, "handoff");
  const reason = asString(args.reason);
  const username = ctx.session.claimedUsername;
  if (!username) {
    throw new ToolError(
      "no_persona",
      "remanifest needs a claimed persona — only registered agents can re-incarnate themselves.",
    );
  }
  const persona = readPersona(ctx.paths, username);
  if (!persona) {
    throw new ToolError(
      "not_registered",
      `Persona '${username}' is not in the registry; cannot remanifest.`,
    );
  }
  if (!ctx.chat_agent_id) {
    throw new ToolError(
      "no_chat_login",
      "remanifest needs you to be logged into chat so the new session knows whose row to close.",
    );
  }

  // Build the spawn args via the pure resolver above. Mode is fixed
  // at "new-tab-here" — the resolver only chooses which window we're
  // landing the new tab in.
  const target = resolveRemanifestTarget(
    ctx.spawn_metadata,
    ctx.spawn_env,
  );
  // Profile preservation — recover the `--profile` this agent was
  // launched under (spawnPersona persists it into PANTHEON_PROFILE)
  // and thread it so the new incarnation relaunches under the SAME
  // profile, i.e. the same CLAUDE_CONFIG_DIR / account. Without this
  // the remanifest drops `--profile` and the new session silently
  // runs on the default ~/.claude account instead of e.g. the
  // work-digital (digital@takt.com) identity. Agents summoned before
  // this fix shipped have no PANTHEON_PROFILE in env — their
  // remanifest still can't recover the profile; this is forward-only.
  const inheritedProfile = asString(ctx.spawn_env.PANTHEON_PROFILE);

  const spawnArgs: Record<string, unknown> = {
    username: persona.username,
    remanifest_of: ctx.chat_agent_id,
    remanifest_handoff: handoff,
    target,
    // The new session must be able to call `exit` from its own
    // process — block_self_exit defaults to off here regardless of
    // whether the calling agent was launched with the block.
    block_self_exit: false,
    // Preserve the calling agent's profile (account identity). Omitted
    // when unknown so spawnPersona's cascade still applies cleanly.
    ...(inheritedProfile ? { profile: inheritedProfile } : {}),
    // Use the same model + permission_mode the calling persona had,
    // by virtue of falling through spawnPersona's cascade.
  };

  const result = (await spawnPersona(spawnArgs, ctx, persona)) as Record<
    string,
    unknown
  >;

  // Self-evict from chat the moment the NEW process has been exec'd.
  // Closes the canonical-handle reclaim race: pre-fix, NEW's `login`
  // saw OLD's row in `allKnownSubscribers` (heartbeat-fresh in
  // SQLite) and auto-suffixed to `<persona>2`; canonical reclaim
  // then waited 60-90s for OLD's row to age out. Now OLD drops its
  // own presence row, so NEW's first login finds canonical free and
  // boots as `<persona>` from message one.
  //
  // Gated on a successful spawn_pid — if the spawn failed, leave
  // OLD's chat presence intact so the user isn't silently evicted
  // from chat for a remanifest that never produced a new session.
  // Heartbeat scheduler checks `subscribers.has(id)` before
  // upserting, so the in-memory remove is enough to stop further
  // heartbeats from re-inserting the row.
  //
  // CRITICAL: `ctx.chat_agent_id` MUST stay set after self-evict.
  // The OLD process exits via the rest_requests pipeline — NEW
  // writes a row addressed to OLD's agent_id on first login, and
  // OLD's prune-tick (`consumeForceLifecycleRequests`) reads
  // `ctx.chat_agent_id` to claim that row. Pre-fix, clearing the
  // id at self-evict made the consumer no-op (early-return on
  // null id), the kill row was never claimed, SIGTERM never fired,
  // and the OLD `claude` process leaked indefinitely (the row got
  // garbage-collected by `pruneStaleRestRequests` after 5 min). The
  // other readers of `chat_agent_id` (heartbeat, send, status
  // update) all guard via `subscribers.has(id)`, so they no-op
  // gracefully once the router row is gone.
  let self_evicted = false;
  if (result.spawn_pid && ctx.chat && ctx.chat_agent_id) {
    const agentId = ctx.chat_agent_id;
    try {
      const removed = ctx.chat.remove(agentId);
      if (removed) {
        try {
          ctx.chat.addMessage({
            from_agent_id: "system",
            scope: "project",
            project: removed.project,
            text: `${removed.username}${removed.transient ? "*" : ""} remanifesting — a fresh incarnation is taking over.`,
            system: true,
            system_kind: "leave",
          });
        } catch {
          // best-effort — the eviction already happened.
        }
        self_evicted = true;
      }
    } catch {
      // best-effort — if remove fails, fall back to current behavior
      // (NEW auto-suffixes and reclaim-canonical sweep cleans up
      // when OLD's row eventually ages out).
    }
  }

  return {
    ok: true,
    remanifested: persona.username,
    handoff_length: handoff.length,
    reason: reason ?? null,
    new_session: {
      spawn_pid: result.spawn_pid ?? null,
      resolved_mode: result.resolved_mode ?? null,
      adapter: result.adapter ?? null,
      tab_title: result.tab_title ?? null,
    },
    self_evicted,
    note: "New incarnation is spawning. As soon as it logs into chat it will signal me (the old session) to exit. You can stop interacting now — the new session takes over.",
  };
};
