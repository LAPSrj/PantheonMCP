/** Search CC conversation history for a persona.
 *
 * Walks every JSONL file under `~/.claude/projects/<encoded-cwd>/`
 * where `<encoded-cwd>` corresponds to the persona's cwd. Each line in
 * a CC session jsonl is a structured message record (`user` /
 * `assistant` / `system` / tool calls / etc.); we extract human-
 * readable text from each and apply the caller's filter.
 *
 * This is NOT durable storage. CC may compact, delete, or evict these
 * files at any time. The tool description carries that warning;
 * callers should save anything they want to keep in memory.
 *
 * Scope:
 *   - `current`  — the JSONL for the calling pantheon session's CC
 *                  parent (resolved via ctx.claude_session_id).
 *   - `previous` — every OTHER JSONL in the persona's directory.
 *   - `all`      — both.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type HistorySearchScope = "current" | "previous" | "all";
export type HistorySearchRole = "user" | "assistant" | "all";

export interface HistorySearchOptions {
  cwd: string;
  query: string;
  /** True → query is a JS regex source. False → substring match. */
  regex?: boolean;
  case_insensitive?: boolean;
  scope?: HistorySearchScope;
  role?: HistorySearchRole;
  /** Cap on returned hits. Defaults to 50. */
  limit?: number;
  /** ISO date lower bound on the message timestamp. */
  since?: string;
  /** Override for ~/.claude/projects/<encoded-cwd>/. Defaults to
   * ~/.claude/projects under HOME. Tests inject a temp path. */
  claudeProjectsRoot?: string;
  /** CC session UUID for the calling pantheon session — used to mark
   * `is_current_session` and to choose scope=current's file. Null when
   * pantheon was launched outside a CC session. */
  currentSessionId?: string | null;
}

export interface HistorySearchHit {
  session_id: string;
  is_current_session: boolean;
  message_at: string | null;
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  snippet: string;
  /** Tiny windowed view of the match — 20 chars before and after the
   * first match offset, with the match itself in the middle. */
  context: string;
  /** Persona this hit's session belonged to. Only stamped by the
   * `_any` variant (`searchHistoryMulti`). Absent on the bare
   * single-persona path. */
  persona_username?: string;
}

/** Persona descriptor for cross-persona search. */
export interface PersonaTarget {
  username: string;
  cwd: string;
}

/** Multi-persona search. Walks each persona's CC project dir in turn,
 * stamping `persona_username` on every hit. Limit is global across
 * all personas — early personas can saturate. To page across personas
 * deterministically, call once per persona. */
export function searchHistoryMulti(
  personas: PersonaTarget[],
  options: Omit<HistorySearchOptions, "cwd" | "currentSessionId"> & {
    /** Optional — only meaningful when one of `personas` is the
     * calling persona. Otherwise hits show is_current_session: false. */
    currentSessionId?: string | null;
  },
): HistorySearchHit[] {
  const limit = options.limit ?? 50;
  const hits: HistorySearchHit[] = [];
  for (const persona of personas) {
    if (hits.length >= limit) break;
    const perPersonaLimit = limit - hits.length;
    const perPersonaOptions: HistorySearchOptions = {
      ...options,
      cwd: persona.cwd,
      limit: perPersonaLimit,
      ...(options.currentSessionId !== undefined
        ? { currentSessionId: options.currentSessionId }
        : {}),
    };
    const personaHits = searchHistory(perPersonaOptions).map((h) => ({
      ...h,
      persona_username: persona.username,
    }));
    hits.push(...personaHits);
  }
  return hits;
}

export function searchHistory(
  options: HistorySearchOptions,
): HistorySearchHit[] {
  const limit = options.limit ?? 50;
  const scope: HistorySearchScope = options.scope ?? "all";
  const role: HistorySearchRole = options.role ?? "all";

  const matcher = buildMatcher(options.query, {
    regex: options.regex ?? false,
    caseInsensitive: options.case_insensitive ?? true,
  });

  const projectsRoot =
    options.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects");
  const encodedCwd = encodeCwdForClaudeProject(options.cwd);
  const dir = path.join(projectsRoot, encodedCwd);

  if (!fs.existsSync(dir)) return [];

  const allFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"));

  const currentId = options.currentSessionId ?? null;
  const inScope = (sessionId: string) => {
    if (scope === "current") return sessionId === currentId;
    if (scope === "previous") return sessionId !== currentId;
    return true;
  };

  const sinceMs = options.since ? Date.parse(options.since) : null;

  // Process most-recent first so partial-limit results lean recent.
  const ordered = allFiles
    .map((f) => ({
      session_id: f.replace(/\.jsonl$/, ""),
      filePath: path.join(dir, f),
      mtime: safeMtime(path.join(dir, f)),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const hits: HistorySearchHit[] = [];
  for (const { session_id, filePath } of ordered) {
    if (hits.length >= limit) break;
    if (!inScope(session_id)) continue;
    const lines = readJsonlSafely(filePath);
    for (const line of lines) {
      if (hits.length >= limit) break;
      const extracted = extractText(line);
      if (extracted === null) continue;
      if (role !== "all" && extracted.role !== role) continue;
      if (sinceMs !== null && extracted.timestampMs !== null) {
        if (extracted.timestampMs < sinceMs) continue;
      }
      const m = matcher.find(extracted.text);
      if (!m) continue;
      hits.push({
        session_id,
        is_current_session: session_id === currentId,
        message_at: extracted.timestamp,
        role: extracted.role,
        snippet: extracted.text.slice(0, 200),
        context: windowedContext(extracted.text, m.offset, m.length),
      });
    }
  }
  return hits;
}

/** CC encodes a cwd into a project-folder name by replacing every '/'
 * with '-'. The leading '/' becomes a leading '-'. */
export function encodeCwdForClaudeProject(cwd: string): string {
  // Resolve to absolute and normalize separators.
  const abs = path.resolve(cwd);
  return abs.replace(/\//g, "-");
}

interface Match {
  offset: number;
  length: number;
}

interface Matcher {
  find(text: string): Match | null;
}

function buildMatcher(
  query: string,
  options: { regex: boolean; caseInsensitive: boolean },
): Matcher {
  if (options.regex) {
    const flags = options.caseInsensitive ? "i" : "";
    let re: RegExp;
    try {
      re = new RegExp(query, flags);
    } catch (err) {
      throw new Error(
        `Invalid regex '${query}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      find(text) {
        const m = re.exec(text);
        return m ? { offset: m.index, length: m[0].length } : null;
      },
    };
  }
  const needle = options.caseInsensitive ? query.toLowerCase() : query;
  return {
    find(text) {
      const hay = options.caseInsensitive ? text.toLowerCase() : text;
      const off = hay.indexOf(needle);
      return off < 0 ? null : { offset: off, length: needle.length };
    },
  };
}

interface ExtractedMessage {
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  text: string;
  timestamp: string | null;
  timestampMs: number | null;
}

/** Pull the human-readable text out of one CC jsonl line. CC line
 * shapes vary by record type; we handle the common shapes:
 *
 *   - { type: "user",      message: { content: <string|array> }, timestamp }
 *   - { type: "assistant", message: { content: <string|array> }, timestamp }
 *   - { type: "system",    text: <string>, timestamp }
 *
 * `content` arrays carry text blocks `{ type: "text", text: "..." }` and
 * tool-use blocks `{ type: "tool_use" | "tool_result", ... }`. We
 * concatenate text blocks; tool blocks are joined as compact JSON so the
 * search can find tool names / arg-values when relevant. */
function extractText(raw: unknown): ExtractedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const timestampMs = timestamp ? Date.parse(timestamp) : null;

  const type = typeof entry.type === "string" ? entry.type : "unknown";
  if (type === "system" && typeof entry.text === "string") {
    return {
      role: "system",
      text: entry.text,
      timestamp,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    };
  }
  if (type === "user" || type === "assistant") {
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) return null;
    const content = msg.content;
    const text = stringifyContent(content);
    if (text.length === 0) return null;
    return {
      role: type,
      text,
      timestamp,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    };
  }
  return null;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
    } else if (b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "tool";
      out.push(`[tool_use ${name}: ${safeStringify(b.input)}]`);
    } else if (b.type === "tool_result") {
      out.push(`[tool_result: ${safeStringify(b.content)}]`);
    }
  }
  return out.join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readJsonlSafely(filePath: string): unknown[] {
  const out: unknown[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed lines silently — partial jsonl on the latest
      // record (CC may have been mid-write) shouldn't kill the search.
    }
  }
  return out;
}

function safeMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function windowedContext(
  text: string,
  matchOffset: number,
  matchLength: number,
): string {
  const before = Math.max(0, matchOffset - 20);
  const afterStart = matchOffset + matchLength;
  const after = Math.min(text.length, afterStart + 20);
  const prefix = before > 0 ? "…" : "";
  const suffix = after < text.length ? "…" : "";
  return (
    prefix +
    text.slice(before, matchOffset) +
    `[${text.slice(matchOffset, afterStart)}]` +
    text.slice(afterStart, after) +
    suffix
  );
}
