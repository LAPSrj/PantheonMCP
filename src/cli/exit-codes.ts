/** Standard exit codes for the `pantheon` CLI subcommands.
 *
 * Per semaphoremole's spec — uniform across every subcommand so
 * shell scripts and CI can branch on the code without parsing
 * stderr. */
export const EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  SCHEMA_ERROR: 2,
  DAEMON_NOT_RUNNING: 3,
  IO_ERROR: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
