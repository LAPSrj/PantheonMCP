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

export interface FetchHistoryMessageOptions {
  cwd: string;
  session_id: string;
  message_at: string;
  /** Cap on returned content length (UTF-16 code units, matches
   * `String.length`). Default 256_000. */
  maxChars?: number;
  claudeProjectsRoot?: string;
}

export interface FetchedHistoryMessage {
  session_id: string;
  message_at: string;
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  /** Full `extractText` projection of the matched record, sliced to
   * `maxChars`. Same projection the search ran against — what you
   * searched is what you get. */
  content: string;
  /** Length of the full content BEFORE the `maxChars` slice. When
   * `size_chars > maxChars` the response sets `truncated: true`. */
  size_chars: number;
  truncated: boolean;
}

export const DEFAULT_FETCH_MAX_CHARS = 256_000;

// ---- validate_user_quote --------------------------------------------- //

export interface ValidateUserQuoteOptions {
  /** Persona's registered cwd. Resolves to `~/.claude/projects/<encoded>/`. */
  cwd: string;
  /** Verbatim substring to look for in user-typed text. */
  quote: string;
  /** Default false — case-insensitive substring match. */
  case_sensitive?: boolean;
  /** Optional ISO lower bound on message timestamp. NO default — the
   * audit case "user said this 3 days ago, agent quoted it today" must
   * succeed. Callers can scope to a window when they want a fast check. */
  since?: string;
  /** Per-field cap on returned text. UTF-16 code units (String.length).
   * Default 256_000, matching `DEFAULT_FETCH_MAX_CHARS`. */
  max_chars?: number;
  /** Cap on number of matches returned, newest-first. Default 1, max 10. */
  limit?: number;
  claudeProjectsRoot?: string;
}

export interface QuoteMatch {
  session_id: string;
  message_at: string | null;
  user_message: string;
  user_message_size_chars: number;
  user_message_truncated: boolean;
  /** Immediately-preceding `role: "assistant"` text block from the same
   * JSONL, walked backward from the matched user record. Null when the
   * match is the first user message in the session. Same strict
   * text-only projection. */
  previous_agent_message: string | null;
  previous_agent_message_size_chars: number;
  previous_agent_message_truncated: boolean;
}

export interface ValidateUserQuoteResult {
  found: boolean;
  matches: QuoteMatch[];
  /** Set only when found is false AND there's a hard failure (no
   * sessions to search). "Quote not present in transcripts" returns
   * found: false WITHOUT an error field — the negative is meaningful. */
  error?: "no_sessions";
}

export const DEFAULT_VALIDATE_LIMIT = 1;
export const MAX_VALIDATE_LIMIT = 10;

export function validateUserQuote(
  options: ValidateUserQuoteOptions,
): ValidateUserQuoteResult {
  const caseSensitive = options.case_sensitive ?? false;
  const maxChars = options.max_chars ?? DEFAULT_FETCH_MAX_CHARS;
  const limitRaw = options.limit ?? DEFAULT_VALIDATE_LIMIT;
  const limit = Math.min(Math.max(1, limitRaw), MAX_VALIDATE_LIMIT);
  const sinceMs = options.since ? Date.parse(options.since) : null;

  const projectsRoot =
    options.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects");
  const encodedCwd = encodeCwdForClaudeProject(options.cwd);
  const dir = path.join(projectsRoot, encodedCwd);

  if (!fs.existsSync(dir)) {
    return { found: false, matches: [], error: "no_sessions" };
  }
  const allFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"));
  if (allFiles.length === 0) {
    return { found: false, matches: [], error: "no_sessions" };
  }

  const needle = caseSensitive ? options.quote : options.quote.toLowerCase();
  if (needle.length === 0) {
    return { found: false, matches: [] };
  }

  const matches: QuoteMatch[] = [];
  // De-dupe key: a queued-then-delivered message can surface as both a
  // queue-operation enqueue AND a real user turn; collapse identical
  // (session, timestamp, text) hits so limit>1 can't return one twice.
  const seen = new Set<string>();
  for (const filename of allFiles) {
    const session_id = filename.replace(/\.jsonl$/, "");
    const filePath = path.join(dir, filename);
    const lines = readJsonlSafely(filePath);
    for (let i = 0; i < lines.length; i++) {
      // A genuine human message is EITHER a materialized role:"user"
      // record OR a mid-turn queue-operation enqueue the main loop never
      // re-logged as a user turn. Both are valid quote sources.
      const extracted =
        extractUserTypedText(lines[i]) ?? extractQueuedUserText(lines[i]);
      if (extracted === null) continue;
      if (
        sinceMs !== null &&
        extracted.timestampMs !== null &&
        extracted.timestampMs < sinceMs
      ) {
        continue;
      }
      const hay = caseSensitive
        ? extracted.text
        : extracted.text.toLowerCase();
      if (!hay.includes(needle)) continue;

      const dedupeKey = `${session_id} ${extracted.timestamp ?? ""} ${extracted.text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const previous = findPreviousAssistantMessage(lines, i);
      const userTruncated = extracted.text.length > maxChars;
      const prevTruncated =
        previous !== null && previous.text.length > maxChars;
      matches.push({
        session_id,
        message_at: extracted.timestamp,
        user_message: userTruncated
          ? extracted.text.slice(0, maxChars)
          : extracted.text,
        user_message_size_chars: extracted.text.length,
        user_message_truncated: userTruncated,
        previous_agent_message:
          previous === null
            ? null
            : prevTruncated
              ? previous.text.slice(0, maxChars)
              : previous.text,
        previous_agent_message_size_chars: previous?.text.length ?? 0,
        previous_agent_message_truncated: prevTruncated,
      });
    }
  }

  // Sort newest-first by message_at (string ISO ordering is correct for
  // RFC 3339 UTC timestamps). Records without timestamps sink to the
  // bottom — preserves determinism without losing them.
  matches.sort((a, b) => {
    const aT = a.message_at ?? "";
    const bT = b.message_at ?? "";
    if (aT !== bT) return aT < bT ? 1 : -1;
    return a.session_id < b.session_id ? 1 : -1;
  });

  const capped = matches.slice(0, limit);
  return { found: capped.length > 0, matches: capped };
}

function findPreviousAssistantMessage(
  lines: unknown[],
  userIdx: number,
): ExtractedMessage | null {
  for (let j = userIdx - 1; j >= 0; j--) {
    const candidate = extractAssistantTypedText(lines[j]);
    if (candidate !== null) return candidate;
  }
  return null;
}

/** Fetch one message from a persona's CC jsonl by `(session_id,
 * message_at)`. Companion to `searchHistory` — the search returns
 * snippets, this returns the full text. Returns `null` when the
 * session file doesn't exist OR no record carries the requested
 * timestamp OR the record's `extractText` projection is empty.
 *
 * Ties on `message_at` (rare; CC stamps message-by-message) resolve
 * to the first matching record in file order. */
export function fetchHistoryMessage(
  options: FetchHistoryMessageOptions,
): FetchedHistoryMessage | null {
  const maxChars = options.maxChars ?? DEFAULT_FETCH_MAX_CHARS;
  const projectsRoot =
    options.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects");
  const encodedCwd = encodeCwdForClaudeProject(options.cwd);
  const filePath = path.join(
    projectsRoot,
    encodedCwd,
    `${options.session_id}.jsonl`,
  );
  if (!fs.existsSync(filePath)) return null;

  const lines = readJsonlSafely(filePath);
  for (const line of lines) {
    const extracted = extractText(line);
    if (extracted === null) continue;
    if (extracted.timestamp !== options.message_at) continue;
    const size_chars = extracted.text.length;
    const truncated = size_chars > maxChars;
    return {
      session_id: options.session_id,
      message_at: options.message_at,
      role: extracted.role,
      content: truncated ? extracted.text.slice(0, maxChars) : extracted.text,
      size_chars,
      truncated,
    };
  }
  return null;
}

// ---- get_history_conversation ---------------------------------------- //
//
// Reconstructs a clean human<->agent conversation from one CC session
// JSONL — the same projection as the standalone `extract_conversation.js`
// tool, ported here. Keeps ONLY real conversational turns:
//
//   - user     : text the human typed (incl. slash-command invocations),
//                with <system-reminder> / <local-command-stdout> /
//                <command-*> plumbing stripped.
//   - agent    : the main assistant's spoken text (non-sidechain).
//   - subagent : a Task/subagent's spoken text (sidechain assistant).
//
// Drops tool_use / tool_result / thinking blocks, system-reminders,
// command stdout, meta records, the summary record, task-notification and
// summon/remanifest bootstrap injections, and `.`-only filler turns.
// Recovers mid-turn human messages CC logged as a `queue-operation`
// enqueue but never re-logged as a real user turn (see flattenConversation
// pre-pass 2). Consecutive same-party turns collapse into one grouped
// entry whose `content` is the array of that party's successive messages.
//
// Pairs with `searchHistory`: a hit carries `session_id`; pass it here to
// read the whole conversation that hit belongs to.

export type ConversationRole = "user" | "agent" | "subagent";

export interface ConversationTurn {
  role: ConversationRole;
  /** That party's successive messages, in order, before the role flips. */
  content: string[];
}

export interface ExtractConversationOptions {
  cwd: string;
  session_id: string;
  /** Char budget (UTF-16 code units). When set and the conversation
   * exceeds it, whole grouped turns are returned until the next turn
   * would overflow, and `next_cursor` points at the first omitted turn.
   * Turns are atomic — never split. Default: no budget (whole thing). */
  maxChars?: number;
  /** Resume index into the grouped-turn array. Default 0. Used to page
   * through a conversation that was budget-truncated. */
  cursor?: number;
  /** Windowed mode: anchor on the grouped turn containing this message
   * timestamp (a `message_at` from a search hit) and return only
   * `contextTurns` turns on either side. Takes precedence over
   * cursor/maxChars. When no turn carries this timestamp,
   * `anchor_turn_index` is null and `turns` is empty. */
  around?: string;
  /** Turns before AND after the anchor to include in windowed mode.
   * Default 3. */
  contextTurns?: number;
  claudeProjectsRoot?: string;
}

export interface ExtractConversationResult {
  session_id: string;
  /** Grouped-turn count for the WHOLE conversation (not just the slice). */
  total_turns: number;
  /** Total content chars across the whole conversation. */
  total_chars: number;
  /** Grouped-turn counts by role across the whole conversation. */
  role_counts: Record<ConversationRole, number>;
  /** The slice of grouped turns this response carries. */
  turns: ConversationTurn[];
  returned_turns: number;
  returned_chars: number;
  /** True when this response does NOT contain the entire conversation —
   * either earlier turns were skipped (cursor / window) or later turns
   * remain (`next_cursor` set). */
  truncated: boolean;
  /** First omitted turn index when more follows, else null. Feed back as
   * `cursor` to page forward. */
  next_cursor: number | null;
  /** Windowed mode only: index of the anchor turn in the full
   * conversation. Null when `around` was given but matched no turn. */
  anchor_turn_index: number | null;
}

export const DEFAULT_CONTEXT_TURNS = 3;

interface FlatTurn {
  role: ConversationRole;
  text: string;
  time: string | null;
}

interface InternalGroup {
  role: ConversationRole;
  content: string[];
  times: (string | null)[];
  chars: number;
}

/** Strip system/plumbing wrappers from a user string; surface command
 * names as `/foo args`. */
function cleanUserString(s: string): string {
  let t = s;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  const name = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  const cargs = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (name) {
    let cmd = name[1]!.trim();
    if (cargs && cargs[1]!.trim()) cmd += " " + cargs[1]!.trim();
    t = t.replace(/<command-name>[\s\S]*?<\/command-name>/g, "");
    t = t.replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
    t = (cmd + "\n" + t).trim();
  }
  return t.trim();
}

/** True for user-type rows that are harness/system injections, not a
 * human turn: task-notifications and the summon/remanifest bootstrap
 * manifest delivered as the first "user" turn. */
function isSystemUserInjection(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("<task-notification")) return true;
  if (/summoned via pantheon|## Remanifest handoff/.test(t)) return true;
  return false;
}

function isInterruptMarker(t: string): boolean {
  return (
    t === "[Request interrupted by user]" ||
    t === "[Request interrupted by user for tool use]"
  );
}

/** `<<autonomous-loop...>>` and friends arrive via the same queue as
 * human messages — they are not human turns. */
function isHarnessSentinel(t: string): boolean {
  return /^<<.*>>$/.test(t.trim());
}

/** Joined `type: "text"` block content from a content array. Skips
 * tool_use / tool_result / image / thinking blocks. */
function textBlocksFromArray(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  const out: string[] = [];
  for (const block of arr) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out.join("\n").trim();
}

/** Walk parsed JSONL records → ordered flat conversational turns. */
function flattenConversation(parsed: unknown[]): FlatTurn[] {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();

  // Pre-pass 1: count materialized human user turns (normalized) so
  // recovery never double-emits one that already exists as a real turn.
  const materializedUserCount: Record<string, number> = {};
  for (const raw of parsed) {
    const o = raw as Record<string, unknown> | null;
    if (!o || o.isMeta || o.type !== "user" || o.isSidechain) continue;
    const c = (o.message as Record<string, unknown> | undefined)?.content;
    if (typeof c !== "string") continue;
    const t = cleanUserString(c);
    if (!t || isInterruptMarker(t) || isSystemUserInjection(t)) continue;
    materializedUserCount[norm(t)] = (materializedUserCount[norm(t)] ?? 0) + 1;
  }

  // Pre-pass 2: recover mid-turn human messages delivered to the agent
  // but never given their own type:"user" record. A message typed while
  // the agent is busy is logged as a `queue-operation` enqueue; one
  // consumed within the ongoing turn is silently dropped by the main
  // loop. Keep it only if it's a genuine human message: has content, not
  // a system injection / interrupt marker / harness sentinel, and not
  // already materialized as a real turn. Disposition (dequeue vs remove)
  // is intentionally ignored — it is not a retract-vs-deliver signal.
  const recoverAt = new Map<number, string>();
  const recoveredSeen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i] as Record<string, unknown> | null;
    if (!o || o.type !== "queue-operation" || o.operation !== "enqueue") continue;
    const content = String(o.content ?? "").trim();
    if (!content || isSystemUserInjection(content) || isInterruptMarker(content)) {
      continue;
    }
    if (isHarnessSentinel(content)) continue;
    if ((materializedUserCount[norm(content)] ?? 0) > 0) continue;
    if (recoveredSeen.has(norm(content))) continue;
    recoveredSeen.add(norm(content));
    recoverAt.set(i, content);
  }

  const out: FlatTurn[] = [];
  for (let li = 0; li < parsed.length; li++) {
    const o = parsed[li] as Record<string, unknown> | null;
    if (!o || o.isMeta) continue;
    const time = typeof o.timestamp === "string" ? o.timestamp : null;

    // assistant: main agent OR subagent (sidechain).
    if (o.type === "assistant") {
      const content = (o.message as Record<string, unknown> | undefined)?.content;
      const text = textBlocksFromArray(content);
      if (!text || text === ".") continue;
      out.push({ role: o.isSidechain ? "subagent" : "agent", text, time });
      continue;
    }

    // user: only the real human, on the main chain.
    if (o.type === "user") {
      if (o.isSidechain) continue;
      const content = (o.message as Record<string, unknown> | undefined)?.content;
      let text = "";
      if (typeof content === "string") text = cleanUserString(content);
      else if (Array.isArray(content)) text = textBlocksFromArray(content);
      if (!text || isInterruptMarker(text) || isSystemUserInjection(text)) continue;
      out.push({ role: "user", text, time });
      continue;
    }

    // queue-operation: recovered mid-turn message (pre-pass 2).
    if (o.type === "queue-operation" && recoverAt.has(li)) {
      out.push({ role: "user", text: recoverAt.get(li)!, time });
    }
  }
  return out;
}

function groupTurns(flat: FlatTurn[]): InternalGroup[] {
  const groups: InternalGroup[] = [];
  for (const m of flat) {
    const last = groups[groups.length - 1];
    if (last && last.role === m.role) {
      last.content.push(m.text);
      last.times.push(m.time);
      last.chars += m.text.length;
    } else {
      groups.push({
        role: m.role,
        content: [m.text],
        times: [m.time],
        chars: m.text.length,
      });
    }
  }
  return groups;
}

/** Reconstruct one CC session's clean grouped conversation. Returns null
 * when the session JSONL doesn't exist (handler maps to `not_found`). */
export function extractConversation(
  options: ExtractConversationOptions,
): ExtractConversationResult | null {
  const projectsRoot =
    options.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects");
  const encodedCwd = encodeCwdForClaudeProject(options.cwd);
  const filePath = path.join(
    projectsRoot,
    encodedCwd,
    `${options.session_id}.jsonl`,
  );
  if (!fs.existsSync(filePath)) return null;

  const groups = groupTurns(flattenConversation(readJsonlSafely(filePath)));

  const total_turns = groups.length;
  const total_chars = groups.reduce((s, g) => s + g.chars, 0);
  const role_counts: Record<ConversationRole, number> = {
    user: 0,
    agent: 0,
    subagent: 0,
  };
  for (const g of groups) role_counts[g.role] += 1;

  const toTurn = (g: InternalGroup): ConversationTurn => ({
    role: g.role,
    content: g.content,
  });
  const sumChars = (gs: InternalGroup[]) => gs.reduce((s, g) => s + g.chars, 0);

  // Windowed mode takes precedence over cursor/budget.
  if (options.around !== undefined) {
    const ctx = Math.max(0, Math.floor(options.contextTurns ?? DEFAULT_CONTEXT_TURNS));
    let anchorIdx = -1;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i]!.times.includes(options.around)) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx < 0) {
      return {
        session_id: options.session_id,
        total_turns,
        total_chars,
        role_counts,
        turns: [],
        returned_turns: 0,
        returned_chars: 0,
        truncated: false,
        next_cursor: null,
        anchor_turn_index: null,
      };
    }
    const start = Math.max(0, anchorIdx - ctx);
    const end = Math.min(groups.length, anchorIdx + ctx + 1);
    const slice = groups.slice(start, end);
    return {
      session_id: options.session_id,
      total_turns,
      total_chars,
      role_counts,
      turns: slice.map(toTurn),
      returned_turns: slice.length,
      returned_chars: sumChars(slice),
      truncated: start > 0 || end < groups.length,
      next_cursor: end < groups.length ? end : null,
      anchor_turn_index: anchorIdx,
    };
  }

  // Cursor + budget mode (whole conversation when neither is set).
  const cursor = Math.max(0, Math.floor(options.cursor ?? 0));
  const budget = options.maxChars;
  const slice: InternalGroup[] = [];
  let i = cursor;
  for (; i < groups.length; i++) {
    const g = groups[i]!;
    if (budget !== undefined && slice.length > 0 && sumChars(slice) + g.chars > budget) {
      break;
    }
    slice.push(g);
  }
  const next_cursor = i < groups.length ? i : null;
  return {
    session_id: options.session_id,
    total_turns,
    total_chars,
    role_counts,
    turns: slice.map(toTurn),
    returned_turns: slice.length,
    returned_chars: sumChars(slice),
    truncated: cursor > 0 || next_cursor !== null,
    next_cursor,
    anchor_turn_index: null,
  };
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

/** STRICT user-typed-text projection — only `content[].type === "text"`
 * blocks of `role: "user"` records. Skips tool_use, tool_result, image,
 * any other block type. Used by `validateUserQuote` so an agent can't
 * spoof a quote by embedding it inside a tool_result they triggered.
 *
 * Also drops system/harness injections that CC materializes as
 * `role: "user"` records with STRING content — task-notifications (the
 * chat-watcher relay), the summon/remanifest bootstrap manifest, interrupt
 * markers, and `<<...>>` sentinels. Without this, a quote an agent merely
 * RELAYED through chat (delivered to the recipient as a task-notification)
 * would validate as if the human typed it — a quote-laundering false
 * positive. The audit answers "did the human type this"; a relay is not
 * the human typing.
 *
 * Returns null when the record is not a user-typed message (wrong role,
 * empty content, only tool blocks, a system injection, etc.). Callers
 * should treat null as "this record cannot contain a real Leandro quote." */
export function extractUserTypedText(raw: unknown): ExtractedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : "unknown";
  if (type !== "user") return null;
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const content = msg.content;
  const text = stringifyUserTextBlocksOnly(content);
  if (text.length === 0) return null;
  if (
    isSystemUserInjection(text) ||
    isInterruptMarker(text) ||
    isHarnessSentinel(text)
  ) {
    return null;
  }
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const timestampMs = timestamp ? Date.parse(timestamp) : null;
  return {
    role: "user",
    text,
    timestamp,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
  };
}

/** Recover a genuine mid-turn human message that CC logged as a
 * `queue-operation` enqueue but never materialized as a `role: "user"`
 * record. When the user types while the agent is mid-turn, the message is
 * enqueued (and may be consumed within the ongoing turn, leaving NO
 * type:"user" record); the only durable artifact is:
 *
 *   { type: "queue-operation", operation: "enqueue", content: "<raw text>", timestamp }
 *
 * Mirrors `flattenConversation` pre-pass 2 (the conversation-extractor
 * already recovers these). Keys on `queue-operation/enqueue` only — the
 * sibling `attachment.queued_command` record carries the same text, so
 * walking both would double-match. Applies the SAME injection guards as
 * `extractUserTypedText` so a task-notification enqueued to the agent (or
 * a `<<...>>` sentinel / interrupt marker) cannot launder back in.
 *
 * Returns null when the record is not a genuine queued human message. */
export function extractQueuedUserText(raw: unknown): ExtractedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (entry.type !== "queue-operation" || entry.operation !== "enqueue") {
    return null;
  }
  const text =
    typeof entry.content === "string" ? entry.content.trim() : "";
  if (text.length === 0) return null;
  if (
    isSystemUserInjection(text) ||
    isInterruptMarker(text) ||
    isHarnessSentinel(text)
  ) {
    return null;
  }
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const timestampMs = timestamp ? Date.parse(timestamp) : null;
  return {
    role: "user",
    text,
    timestamp,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
  };
}

/** STRICT assistant-text projection — only `content[].type === "text"`
 * blocks of `role: "assistant"` records. Skips tool_use blocks (the
 * agent's tool invocations are not "what the agent said" for audit
 * purposes). Pair to `extractUserTypedText`. */
export function extractAssistantTypedText(
  raw: unknown,
): ExtractedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : "unknown";
  if (type !== "assistant") return null;
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const text = stringifyAssistantTextBlocksOnly(msg.content);
  if (text.length === 0) return null;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const timestampMs = timestamp ? Date.parse(timestamp) : null;
  return {
    role: "assistant",
    text,
    timestamp,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
  };
}

function stringifyUserTextBlocksOnly(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
    }
    // Everything else (tool_use, tool_result, image, ...) is
    // intentionally dropped — those are NOT user-typed input.
  }
  return out.join("\n");
}

function stringifyAssistantTextBlocksOnly(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
    }
    // tool_use intentionally dropped.
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
