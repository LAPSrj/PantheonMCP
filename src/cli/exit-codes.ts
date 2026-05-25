/** Standard exit codes for the `pantheon` CLI subcommands.
 *
 * Per semaphoremole's spec — uniform across every subcommand so
 * shell scripts and CI can branch on the code without parsing
 * stderr.
 *
 * `PRESENCE_LAPSED` (3) is raised by `pantheon-fetch` when the
 * caller's subscriber row has been pruned from the chat router —
 * either at startup (no row to look up) or mid-loop (row vanished
 * past the prune grace). Both cases are recoverable only by
 * re-calling `mcp__pantheon__login` from the agent side; the
 * fetch watcher cannot reconnect under the dead agent_id. The
 * code was previously named DAEMON_NOT_RUNNING — that label was a
 * historical misnomer (pantheon is a per-conversation MCP child,
 * not a long-running daemon). The numeric value (3) is unchanged
 * so consumer scripts keep working. */
export const EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  SCHEMA_ERROR: 2,
  PRESENCE_LAPSED: 3,
  IO_ERROR: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
