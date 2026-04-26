/** §10 guest affordance allowlist. Tools NOT in this set error
 * `no_persona` when called from a guest session. The list is the
 * single dispatcher gate — cheaper than per-tool checks. */
export const GUEST_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  // Chat — first-class participants
  "send_message",
  "set_mode",
  "list_agents",
  "ask",
  "update_status",
  "check_messages",
  "logout",
  "find_role",
  // Identity introspection (read-only)
  "session_info",
  "whoami",
  "manifest", // benign on a guest cwd: returns 0 matches
  // Promote path — the guest's only mutation tool
  "login", // for the `{ promote }` shape
]);

export function isGuestAllowed(toolName: string): boolean {
  return GUEST_ALLOWED_TOOLS.has(toolName);
}
