import fs from "node:fs";
import path from "node:path";
import type { Paths } from "../storage/index.ts";
import type { Message } from "./types.ts";

/** §6 HIGH — durable chat audit log. Yapsmith's `9b00a1d` audit
 * post-mortem flagged the in-memory + SQLite-only chat history as
 * insufficient for cross-agent dispute resolution: when attribution
 * is contested (was-said vs was-not-said), the canonical witness
 * needs to outlive a daemon restart AND a SQLite WAL truncation
 * window.
 *
 * This module appends one JSON line per persisted message to
 * `${stateDir}/chat-audit.jsonl`. The format is purposely minimal
 * — id + ts + agent_id + scope + target + text — so even a partial
 * write is human-readable. Rotation + retention are deferred to
 * Leandro's discretion; the file grows indefinitely until externally
 * managed.
 *
 * **Gated by env**: defaults OFF. Set `PANTHEON_CHAT_AUDIT_LOG=1`
 * to enable. The router calls `appendAudit` only when
 * `isAuditEnabled()` returns true; per-process check (no recompute
 * cost beyond an env-var read on each addMessage). */

const ENV_VAR = "PANTHEON_CHAT_AUDIT_LOG";

export function isAuditEnabled(): boolean {
  const v = process.env[ENV_VAR];
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/** Resolve the audit log path. Override via env
 * `PANTHEON_CHAT_AUDIT_PATH`; otherwise `${stateDir}/chat-audit.jsonl`. */
export function auditPath(paths: Paths): string {
  return process.env.PANTHEON_CHAT_AUDIT_PATH ??
    path.join(paths.stateDir, "chat-audit.jsonl");
}

/** Append one line per message. Best-effort: on write failure,
 * silently swallow — never let the audit log block a chat send. The
 * router's normal SQLite persistence is the live record; the audit
 * file is the durability backstop. */
export function appendAudit(paths: Paths, msg: Message): void {
  if (!isAuditEnabled()) return;
  const target = auditPath(paths);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const line = JSON.stringify({
      ts: msg.ts,
      seq: msg.seq,
      id: msg.id,
      from_agent_id: msg.from_agent_id,
      from_username: msg.from_username_inline ?? null,
      from_project: msg.from_project,
      scope: msg.scope,
      ...(msg.target !== undefined ? { target: msg.target } : {}),
      ...(msg.project !== undefined ? { project: msg.project } : {}),
      ...(msg.system ? { system: true } : {}),
      ...(msg.system_kind !== undefined ? { system_kind: msg.system_kind } : {}),
      ...(msg.system_actor !== undefined ? { system_actor: msg.system_actor } : {}),
      ...(msg.ask_id !== undefined ? { ask_id: msg.ask_id } : {}),
      ...(msg.in_reply_to_ask !== undefined ? { in_reply_to_ask: msg.in_reply_to_ask } : {}),
      ...(msg.reply_to !== undefined ? { reply_to: msg.reply_to } : {}),
      ...(msg.mentions.length > 0 ? { mentions: msg.mentions } : {}),
      text: msg.text,
    }) + "\n";
    fs.appendFileSync(target, line);
  } catch {
    // best-effort
  }
}
