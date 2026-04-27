// Admin console formatter. Mirrors chat-mcp/src/format.ts so the
// `pantheon console` REPL renders messages with the same headers,
// destination labels, body wrapping, and admin styling. Operates on a
// normalized `ConsoleMessage` shape (see normalize.ts) so the same
// renderer covers both backfill rows and live tail rows.

import type { MessageRow } from "../chat/persistence.ts";
import type { PresenceRow } from "../chat/presence.ts";
import { renderMarkdownBlock } from "./console-markdown.ts";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  grey: "\x1b[90m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

export type AnsiColor = keyof typeof ANSI;

const INDENT = "";
const MIN_BODY_WIDTH = 20;

export interface ConsoleMessage {
  ts: number;
  scope: "global" | "project" | "dm";
  text: string;
  /** Resolved sender display name. "admin" for console broadcasts;
   * persona username via presence lookup; "<guest>*" with asterisk for
   * guests; "agent:8chars" fallback for senders no longer connected. */
  from: string;
  /** Sender's project, when known. Rendered as a `[project]` tag
   * before the username on non-admin messages, mirroring chat-mcp. */
  from_project?: string;
  /** True when `from === "admin"` — drives the red+bold sender style
   * and the bolded body. The only special-cased actor (no general role
   * attribute exists). */
  from_admin: boolean;
  /** True for system events (joins/leaves/digests). Renders grey. */
  system: boolean;
  /** Set on system messages whose body is "username status: ...".
   * Carries over chat-mcp's italic+grey styling for legacy status
   * messages. */
  system_kind?: string;
  /** Username of the actor for system events (joins, leaves, status,
   * promotion, etc.). For migrated chat-mcp transcripts this comes
   * from the original `system_actor` field; for pantheon-native rows
   * it comes from `from_username_inline` on system kinds. Renders as
   * a bold-cyan header line above the body for `status` /
   * `status_update` kinds. */
  system_actor?: string;
  /** dm: target username. project: project name. global: undefined. */
  target?: string;
  /** Recipient's project for cross-project DMs — surfaces as
   * `magenta_user [grey:project]` after the arrow. */
  target_project?: string;
  ask_id?: string;
  in_reply_to_ask?: string;
}

export interface Formatter {
  format(m: ConsoleMessage): string;
}

export function createFormatter(color: boolean): Formatter {
  const paint = (c: AnsiColor, s: string): string =>
    color ? `${ANSI[c]}${s}${ANSI.reset}` : s;

  const termWidth = (): number => {
    const c = process.stdout.columns;
    return typeof c === "number" && c > 0 ? c : 80;
  };

  const wrap = (text: string, width: number): string[] => {
    const w = Math.max(MIN_BODY_WIDTH, width);
    const out: string[] = [];
    for (const segment of text.split("\n")) {
      if (segment.length <= w) {
        out.push(segment);
        continue;
      }
      let rest = segment;
      while (rest.length > w) {
        let brk = rest.lastIndexOf(" ", w);
        if (brk <= 0) brk = w;
        out.push(rest.slice(0, brk));
        rest = rest.slice(brk).trimStart();
      }
      if (rest.length) out.push(rest);
    }
    return out;
  };

  const renderBody = (
    text: string,
    bodyStyle?: AnsiColor | AnsiColor[],
  ): string => {
    const width = Math.max(MIN_BODY_WIDTH, termWidth() - INDENT.length);
    if (bodyStyle) {
      const styles = Array.isArray(bodyStyle) ? bodyStyle : [bodyStyle];
      const lines = wrap(text, width);
      const stylize = (l: string): string =>
        styles.reduce<string>((acc, c) => paint(c, acc), l);
      return lines.map((l) => INDENT + stylize(l)).join("\n");
    }
    if (!color) {
      return wrap(text, width)
        .map((l) => INDENT + l)
        .join("\n");
    }
    const rendered = renderMarkdownBlock(text, width);
    return rendered
      .split("\n")
      .map((l) => INDENT + l)
      .join("\n");
  };

  const destLabel = (m: ConsoleMessage): string => {
    if (m.scope === "global") return paint("green", "Everyone");
    if (m.scope === "project") return paint("cyan", `#${m.target ?? "?"}`);
    const user = paint("magenta", m.target ?? "?");
    const showTargetProj =
      m.target_project && m.target_project !== m.from_project;
    const proj = showTargetProj
      ? " " + paint("grey", `[${m.target_project}]`)
      : "";
    return `${user}${proj}`;
  };

  const format = (m: ConsoleMessage): string => {
    const when = new Date(m.ts).toLocaleTimeString("en-GB");
    const time = paint("grey", when);

    if (m.system) {
      // Two-line render for status events with a known actor —
      // matches chat-mcp's `status` shape. Pantheon's `status_update`
      // and `status_digest` kinds get the same treatment.
      const isStatusKind =
        m.system_kind === "status" ||
        m.system_kind === "status_update" ||
        m.system_kind === "status_digest";
      if (isStatusKind && m.system_actor) {
        const actor = paint("bold", paint("cyan", m.system_actor));
        const header = `${time} ${actor} ${paint("grey", "status:")}`;
        return `${header}\n${renderBody(m.text, ["grey", "italic"])}`;
      }
      if (m.system_kind === "status_digest") {
        // Digest with no resolvable actor — keep the legacy header.
        const header = `${time} ${paint("grey", "·")} ${paint("grey", "status_digest")}`;
        return `${header}\n${renderBody(m.text, ["grey", "italic"])}`;
      }
      // Legacy single-line status messages still look like
      // "username status: foo". Italicize them so they match the
      // newer two-line status style.
      const isLegacyStatus = /\bstatus:\s/i.test(m.text);
      const body = isLegacyStatus
        ? paint("italic", paint("grey", m.text))
        : paint("grey", m.text);
      return `${time} ${paint("grey", "·")} ${body}`;
    }

    const arrow = paint("grey", "->");
    const ask = m.ask_id
      ? " " + paint("yellow", "[?]")
      : m.in_reply_to_ask
        ? " " + paint("yellow", "[↳]")
        : "";

    if (m.from_admin) {
      const from = paint("bold", paint("red", "admin"));
      const header = `${time} ${from} ${arrow} ${destLabel(m)}${ask}`;
      return `${header}\n${renderBody(m.text, "bold")}`;
    }

    const fromProjTag = m.from_project
      ? paint("grey", `[${m.from_project}]`) + " "
      : "";
    const from = paint("bold", paint("cyan", m.from));
    const header = `${time} ${fromProjTag}${from} ${arrow} ${destLabel(m)}${ask}`;
    return `${header}\n${renderBody(m.text)}`;
  };

  return { format };
}

export function paintWith(
  color: boolean,
): (c: AnsiColor, s: string) => string {
  return (c, s) => (color ? `${ANSI[c]}${s}${ANSI.reset}` : s);
}

/** Convert a SQLite `MessageRow` + a presence index into the
 * normalized `ConsoleMessage` shape the formatter operates on.
 *
 * - Admin: `from_agent_id="system"` + `from_username_inline="admin"`
 *   → `from="admin"`, `from_admin=true`. No `*` (admin is not a guest).
 * - Guest: `from_username_inline` set (and not admin) → `from="name*"`.
 * - Persona: agent_id resolved against the live presence index;
 *   missing → `agent:8chars` fallback (sender disconnected). */
export function normalizeRow(
  row: MessageRow,
  presence: ReadonlyMap<string, PresenceRow>,
): ConsoleMessage {
  const isAdmin =
    row.from_agent_id === "system" && row.from_username_inline === "admin";
  const isSystem = row.kind !== null;
  let from: string;
  let from_project: string | undefined;
  let system_actor: string | undefined;
  if (isAdmin) {
    from = "admin";
  } else if (row.from_agent_id === "system") {
    // System event: `from_username_inline` (when present) names the
    // actor for the event (joiner, leaver, status author, etc.).
    // This is migrated from chat-mcp's `system_actor` field and is
    // NOT a guest marker — the `*` suffix only applies to guests
    // (from_transient=1).
    from = "system";
    if (row.from_username_inline) system_actor = row.from_username_inline;
  } else if (row.from_transient === 1 && row.from_username_inline) {
    from = `${row.from_username_inline}*`;
  } else {
    const me = presence.get(row.from_agent_id);
    if (me) {
      from = me.username;
      from_project = me.project;
    } else {
      from = `agent:${row.from_agent_id.slice(0, 8)}`;
    }
  }

  let target: string | undefined;
  let target_project: string | undefined;
  if (row.scope === "dm") {
    target = row.target_username ?? undefined;
    if (target) {
      const targetSub = lookupByUsername(presence, target);
      if (targetSub) target_project = targetSub.project;
    }
  } else if (row.scope === "project") {
    target = row.project ?? undefined;
  }

  return {
    ts: row.ts,
    scope: row.scope,
    text: row.text,
    from,
    ...(from_project !== undefined ? { from_project } : {}),
    from_admin: isAdmin,
    system: isSystem && !isAdmin,
    ...(row.kind ? { system_kind: row.kind } : {}),
    ...(system_actor !== undefined ? { system_actor } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(target_project !== undefined ? { target_project } : {}),
    ...(row.correlation_id && row.scope !== "dm"
      ? { ask_id: row.correlation_id }
      : {}),
    // ask vs answer is encoded by whether the row is the question or
    // the reply; messages.correlation_id is set on both. We can't
    // distinguish them from the row alone — render `[?]` only on the
    // sender side (when there's no `reply_to`) and `[↳]` when there's
    // a reply_to that pairs with a correlation_id.
    ...(row.reply_to && row.correlation_id
      ? { in_reply_to_ask: row.correlation_id }
      : {}),
  };
}

function lookupByUsername(
  presence: ReadonlyMap<string, PresenceRow>,
  username: string,
): PresenceRow | undefined {
  for (const r of presence.values()) {
    if (r.username === username) return r;
  }
  return undefined;
}

export function buildPresenceIndex(rows: PresenceRow[]): Map<string, PresenceRow> {
  const m = new Map<string, PresenceRow>();
  for (const r of rows) m.set(r.agent_id, r);
  return m;
}
