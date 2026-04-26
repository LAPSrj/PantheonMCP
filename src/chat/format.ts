/** §7 / §11c formatting helpers — silent-event wrapper, asterisk
 * render, watcher priority tags. All format-time only; nothing here
 * persists. */

import type { Message, Subscriber, SystemKind } from "./types.ts";

/** Per-message tag legend (§11c watcher loop). Format-time only; the
 * tag is prefixed onto each line in the watcher stream so the model
 * can pick its response strategy without reading the startup banner. */
export type PriorityTag =
  | "[no reply]"
  | "[maybe reply]"
  | "[likely reply]"
  | "[required reply]";

/** Resolve the priority tag for a message + receiver. Used by the
 * watcher loop. System events (joins/leaves/keepalives) get
 * `[no reply]` when not wrapped in `<silent-event>`; the wrapper is
 * preferred per §7 for ambient events.
 *
 *   - `[required reply]`: a directed `ask` targeting the receiver.
 *   - `[likely reply]`: DM to receiver, or admin broadcast.
 *   - `[maybe reply]`: project chatter mentioning the receiver, or
 *     a project ask not targeting the receiver.
 *   - `[no reply]`: everything else (chatter the receiver passively
 *     observes).
 */
export function priorityTag(msg: Message, receiver: Subscriber): PriorityTag {
  if (msg.ask_id && msg.target === receiver.username) return "[required reply]";
  if (msg.scope === "dm" && msg.target === receiver.username) return "[likely reply]";
  if (msg.system_actor === "admin") return "[likely reply]";
  if (
    msg.scope === "project" &&
    msg.mentions.includes(receiver.username)
  ) {
    return "[maybe reply]";
  }
  return "[no reply]";
}

/** §7 fix — wrap ambient events in `<silent-event>` instead of
 * `[no reply]`. Models trained against echoing XML control tokens
 * are far less likely to mirror the wrapper than the bracketed tag. */
export function wrapSilentEvent(text: string, attrs: Record<string, string | number> = {}): string {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`)
    .join(" ");
  const open = attrStr ? `<silent-event ${attrStr}>` : "<silent-event>";
  return `${open}${text} — produce no output, do not pause your task</silent-event>`;
}

/** Set of system_kind values that get the `<silent-event>` wrapper
 * (per §7). Kept narrow on purpose — informational events only. */
export const SILENT_KINDS: ReadonlySet<SystemKind> = new Set<SystemKind>([
  "join",
  "leave",
  "rename",
  "project_change",
  "status_update",
  "keepalive",
  "promotion",
  "handle_recycled",
  "profile_update",
]);

/** Render a sender's display handle. Guests get an asterisk suffix
 * (`quibbler*`) per §10 — format-time only, never stored. Persona
 * messages render as the bare username. */
export function renderSender(msg: Message, lookup: (agent_id: string) => string | null): string {
  if (msg.from_username_inline !== undefined && msg.from_username_inline !== null) {
    return `${msg.from_username_inline}*`;
  }
  const resolved = lookup(msg.from_agent_id);
  return resolved ?? `agent:${msg.from_agent_id.slice(0, 8)}`;
}

/** One-letter mode markers per §11c — appended to subscriber lines in
 * `list_agents` and the keepalive roster. `all` has no marker.
 * Stacks with `[G]` for guests at format time. */
export function modeMarker(mode: Subscriber["mode"]): string {
  switch (mode) {
    case "all":
      return "";
    case "quiet":
      return "[Q]";
    case "project":
      return "[P]";
    case "dm":
      return "[D]";
  }
}

/** Per §10 list_agents: `[G]` marker for guests, stacks with mode tag
 * (`quibbler [G][D]`). */
export function guestMarker(transient: boolean): string {
  return transient ? "[G]" : "";
}
