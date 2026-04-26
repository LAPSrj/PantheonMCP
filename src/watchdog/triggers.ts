/** §14 reset-trigger taxonomy.
 *
 * `RESET_TRIGGER_TOOLS` is the explicit list of tool names that MUST
 * touch the watchdog when invoked. In vanilla MCP mode, the dispatcher
 * additionally touches on every incoming MCP request from the session
 * (broader than this list); in plugin mode, the CC PreToolUse hook
 * touches on every CC tool-use event. Both modes converge on
 * `Watchdog.touch(sessionId)`.
 *
 * This list is documentation + a minimum coverage check — wire any
 * new tool that fits the §14 "agent is actively being needed" rule
 * into this set so we don't drift.
 */
export const RESET_TRIGGER_TOOLS: ReadonlySet<string> = new Set([
  // Chat
  "send_message",
  "update_status",
  "ask",
  "answer",
  "set_mode",
  // Memory
  "append_memory",
  "update_memory",
  "fade_memory",
  "forget_memory",
  "recall_memory",
  "get_memory_details",
  "set_memory",
  // Identity
  "claim",
  "manifest",
  "become",
  "register",
  "update_profile",
  "unregister",
  // Lifecycle
  "extend_rest",
]);

/** Tools that intentionally do NOT trigger reset. Pure-observation
 * reads where the agent is observed (peers / clients querying it)
 * rather than observing. Cross-checked at handler-wire time. */
export const NON_RESET_TOOLS: ReadonlySet<string> = new Set([
  "check_messages",
  "list_agents",
  "list",
  "whoami",
  "session_info",
  "get_memory",
  "list_memory",
  "find_role",
]);

/** Returns true when the named tool, if invoked from a session, must
 * touch the watchdog. Covers the explicit reset list AND treats any
 * tool not in `NON_RESET_TOOLS` as a reset trigger (the vanilla-MCP
 * "every request counts" rule). */
export function isResetTrigger(toolName: string): boolean {
  if (RESET_TRIGGER_TOOLS.has(toolName)) return true;
  if (NON_RESET_TOOLS.has(toolName)) return false;
  // Default: unknown / new tools count as activity. Better to over-
  // reset than to under-reset and have an actively-working agent
  // get auto-rested.
  return true;
}
