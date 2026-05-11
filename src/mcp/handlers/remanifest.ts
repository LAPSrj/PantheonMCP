/** `remanifest` MCP handler.
 *
 * The calling agent's context has gotten unwieldy (long /compact run,
 * working tree the agent no longer trusts, drift, etc.). Instead of
 * closing and re-summoning by hand, `remanifest` spawns a fresh
 * incarnation of the SAME persona into a sibling pane (or new tab),
 * passes a handoff text the new incarnation will see in its first
 * turn, and arranges for the OLD session to close as soon as the new
 * one has logged into chat. The new session reclaims the canonical
 * chat handle automatically once the old's presence row is gone.
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
 * Default `inherit_pane: true` resolves the launcher target as
 * split-pane on adapters that support it (wt / kitty / tmux). Falls
 * back to a new tab on adapters that don't. */

import { readPersona } from "../../identity/index.ts";
import { spawnPersona } from "./spawn.ts";
import {
  asBoolean,
  asString,
  asStringRequired,
  type Handler,
  ToolError,
} from "../types.ts";

export const remanifest: Handler = async (args, ctx) => {
  const handoff = asStringRequired(args.handoff, "handoff");
  const inherit_pane = asBoolean(args.inherit_pane) ?? true;
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

  // Build the spawn args. Reuse this session's window when
  // inherit_pane (default) so the new pane lands adjacent and the
  // tab closes with the old. Fall back to a fresh window otherwise.
  const oldWindowName = ctx.spawn_metadata?.window_name;
  const spawnArgs: Record<string, unknown> = {
    username: persona.username,
    remanifest_of: ctx.chat_agent_id,
    remanifest_handoff: handoff,
    target: inherit_pane && oldWindowName
      ? { window: oldWindowName, mode: "split-pane" }
      : { mode: "new-tab" },
    // The new session must be able to call `exit` from its own
    // process — block_self_exit defaults to off here regardless of
    // whether the calling agent was launched with the block.
    block_self_exit: false,
    // Use the same model + permission_mode the calling persona had,
    // by virtue of falling through spawnPersona's cascade.
  };

  const result = (await spawnPersona(spawnArgs, ctx, persona)) as Record<
    string,
    unknown
  >;

  return {
    ok: true,
    remanifested: persona.username,
    handoff_length: handoff.length,
    inherit_pane,
    reason: reason ?? null,
    new_session: {
      spawn_pid: result.spawn_pid ?? null,
      resolved_mode: result.resolved_mode ?? null,
      adapter: result.adapter ?? null,
      tab_title: result.tab_title ?? null,
    },
    note: "New incarnation is spawning. As soon as it logs into chat it will signal me (the old session) to exit. You can stop interacting now — the new session takes over.",
  };
};
