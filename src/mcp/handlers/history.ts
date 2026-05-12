/** Search-history MCP handler.
 *
 * Pantheon doesn't durably store conversation transcripts — CC's
 * JSONL files do. This handler walks them for the current persona
 * and applies a substring / regex filter. The tool description must
 * warn callers loudly: anything they want to recall later goes in
 * memory; CC jsonls can be compacted, deleted, or evicted. */

import { listPersonas, readPersona } from "../../identity/index.ts";
import {
  fetchHistoryMessage,
  searchHistory,
  searchHistoryMulti,
  validateUserQuote,
  type HistorySearchScope,
  type HistorySearchRole,
  type PersonaTarget,
} from "../../history-search/index.ts";
import {
  asBoolean,
  asNumber,
  asString,
  asStringRequired,
  type Handler,
  ToolError,
} from "../types.ts";

function asScope(v: unknown): HistorySearchScope | undefined {
  if (v === undefined) return undefined;
  if (v === "current" || v === "previous" || v === "all") return v;
  throw new ToolError(
    "invalid_argument",
    `'scope' must be one of 'current' | 'previous' | 'all'.`,
  );
}

function asRoleFilter(v: unknown): HistorySearchRole | undefined {
  if (v === undefined) return undefined;
  if (v === "user" || v === "assistant" || v === "all") return v;
  throw new ToolError(
    "invalid_argument",
    `'role' must be one of 'user' | 'assistant' | 'all'.`,
  );
}

interface CommonArgs {
  query: string;
  regex: boolean;
  case_insensitive: boolean;
  scope: HistorySearchScope;
  role: HistorySearchRole;
  limit?: number;
  since?: string;
}

function parseCommon(args: Record<string, unknown>): CommonArgs {
  const query = asStringRequired(args.query, "query");
  const regex = asBoolean(args.regex) ?? false;
  const case_insensitive = asBoolean(args.case_insensitive) ?? true;
  const scope = asScope(args.scope) ?? "all";
  const role = asRoleFilter(args.role) ?? "all";
  const limit = asNumber(args.limit);
  const since = asString(args.since);
  return {
    query,
    regex,
    case_insensitive,
    scope,
    role,
    ...(limit !== undefined ? { limit } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

const HISTORY_WARNING =
  "Conversation history is NOT durable storage. CC may compact, delete, or evict these jsonl files at any time. Save anything you want to keep with `append_memory`.";

export const search_history: Handler = async (args, ctx) => {
  const common = parseCommon(args);

  const username =
    ctx.session.claimedUsername ?? ctx.session.guestUsername ?? null;
  if (!username) {
    throw new ToolError(
      "no_persona",
      "search_history needs a claimed persona — claim one (or wait for the bootstrap claim) before calling.",
    );
  }
  const persona = readPersona(ctx.paths, username);
  if (!persona) {
    throw new ToolError(
      "not_registered",
      `Persona '${username}' is not in the registry; can't resolve its cwd.`,
    );
  }

  try {
    const hits = searchHistory({
      ...common,
      cwd: persona.cwd,
      currentSessionId: ctx.claude_session_id,
    });
    return {
      ok: true,
      ...common,
      current_session_id: ctx.claude_session_id,
      count: hits.length,
      hits,
      warning: HISTORY_WARNING,
    };
  } catch (err) {
    throw new ToolError(
      "invalid_argument",
      err instanceof Error ? err.message : String(err),
    );
  }
};

/** Cross-persona variant. Either `target_username` (search one peer's
 * history) OR `project` (search every persona registered in that
 * project) must be supplied. Hits carry a `persona_username` field so
 * the caller can attribute. is_current_session is false for every hit
 * except those in the caller's own session (only possible if the
 * caller is one of the resolved personas). */
export const search_history_any: Handler = async (args, ctx) => {
  const common = parseCommon(args);
  const target_username = asString(args.target_username);
  const project = asString(args.project);
  if (!target_username && !project) {
    throw new ToolError(
      "invalid_argument",
      "search_history_any requires either `target_username` (one persona) or `project` (all personas in that project).",
    );
  }

  let personas: PersonaTarget[];
  if (target_username) {
    const persona = readPersona(ctx.paths, target_username);
    if (!persona) {
      throw new ToolError(
        "not_registered",
        `Persona '${target_username}' is not in the registry.`,
      );
    }
    if (project !== undefined && persona.project !== project) {
      throw new ToolError(
        "invalid_argument",
        `Persona '${target_username}' is in project '${persona.project}', not '${project}'.`,
      );
    }
    personas = [{ username: persona.username, cwd: persona.cwd }];
  } else {
    // project-wide: every persona whose `project` matches.
    const all = listPersonas(ctx.paths).filter((p) => p.project === project);
    if (all.length === 0) {
      return {
        ok: true,
        ...common,
        ...(target_username !== undefined ? { target_username } : {}),
        ...(project !== undefined ? { project } : {}),
        current_session_id: ctx.claude_session_id,
        count: 0,
        hits: [],
        personas_searched: [],
        warning: HISTORY_WARNING,
      };
    }
    personas = all.map((p) => ({ username: p.username, cwd: p.cwd }));
  }

  try {
    const hits = searchHistoryMulti(personas, {
      ...common,
      currentSessionId: ctx.claude_session_id,
    });
    return {
      ok: true,
      ...common,
      ...(target_username !== undefined ? { target_username } : {}),
      ...(project !== undefined ? { project } : {}),
      current_session_id: ctx.claude_session_id,
      count: hits.length,
      hits,
      personas_searched: personas.map((p) => p.username),
      warning: HISTORY_WARNING,
    };
  } catch (err) {
    throw new ToolError(
      "invalid_argument",
      err instanceof Error ? err.message : String(err),
    );
  }
};

interface FetchArgs {
  session_id: string;
  message_at: string;
  max_chars?: number;
}

function parseFetchArgs(args: Record<string, unknown>): FetchArgs {
  const session_id = asStringRequired(args.session_id, "session_id");
  const message_at = asStringRequired(args.message_at, "message_at");
  const max_chars = asNumber(args.max_chars);
  return {
    session_id,
    message_at,
    ...(max_chars !== undefined ? { max_chars } : {}),
  };
}

/** Fetch the full untruncated text of one message from the calling
 * persona's CC jsonls. Pair with `search_history` — use the hit's
 * `session_id` + `message_at` verbatim. Returns `not_found` when the
 * session file is missing OR no record carries that timestamp. */
export const get_history_message: Handler = async (args, ctx) => {
  const parsed = parseFetchArgs(args);

  const username =
    ctx.session.claimedUsername ?? ctx.session.guestUsername ?? null;
  if (!username) {
    throw new ToolError(
      "no_persona",
      "get_history_message needs a claimed persona — claim one (or wait for the bootstrap claim) before calling.",
    );
  }
  const persona = readPersona(ctx.paths, username);
  if (!persona) {
    throw new ToolError(
      "not_registered",
      `Persona '${username}' is not in the registry; can't resolve its cwd.`,
    );
  }

  const fetched = fetchHistoryMessage({
    cwd: persona.cwd,
    session_id: parsed.session_id,
    message_at: parsed.message_at,
    ...(parsed.max_chars !== undefined ? { maxChars: parsed.max_chars } : {}),
  });
  if (fetched === null) {
    throw new ToolError(
      "not_found",
      `no message at '${parsed.message_at}' in session '${parsed.session_id}' for persona '${username}'.`,
    );
  }
  return {
    ok: true,
    ...fetched,
    warning: HISTORY_WARNING,
  };
};

/** Cross-persona variant. Requires `target_username` (the
 * `persona_username` from a `search_history_any` hit). No `project`
 * mode here: a single `(session_id, message_at)` resolves to exactly
 * one persona, and the search hit already attributes via
 * `persona_username`. */
export const get_history_message_any: Handler = async (args, ctx) => {
  const parsed = parseFetchArgs(args);
  const target_username = asStringRequired(
    args.target_username,
    "target_username",
  );

  const persona = readPersona(ctx.paths, target_username);
  if (!persona) {
    throw new ToolError(
      "not_registered",
      `Persona '${target_username}' is not in the registry.`,
    );
  }

  const fetched = fetchHistoryMessage({
    cwd: persona.cwd,
    session_id: parsed.session_id,
    message_at: parsed.message_at,
    ...(parsed.max_chars !== undefined ? { maxChars: parsed.max_chars } : {}),
  });
  if (fetched === null) {
    throw new ToolError(
      "not_found",
      `no message at '${parsed.message_at}' in session '${parsed.session_id}' for persona '${target_username}'.`,
    );
  }
  return {
    ok: true,
    ...fetched,
    persona_username: persona.username,
    warning: HISTORY_WARNING,
  };
};

/** Audit-grade quote verification.
 *
 * Pass `username` + a verbatim `quote`. The tool walks the persona's CC
 * JSONLs and reports whether the quote appears in a `role: "user"`
 * record's `content[].type === "text"` blocks — strictly. Tool_use,
 * tool_result, image, and other block types are excluded from the
 * projection so an agent cannot spoof a "Leandro said X" claim by
 * triggering a tool whose result contains the literal text.
 *
 * Inherently cross-persona / cross-project — no `_any` variant. The
 * caller (typically an auditor like `righthand`) names the persona
 * being audited; no relationship to the caller's session.
 *
 * Response shape is uniform: `matches: QuoteMatch[]` always, capped by
 * `limit` (default 1, max 10). `found: false` with empty matches means
 * "not in transcripts" (truthful negative). `error: "unknown_persona"`
 * or `error: "no_sessions"` distinguishes hard failures from clean
 * negatives. */
export const validate_user_quote: Handler = async (args, ctx) => {
  const username = asStringRequired(args.username, "username");
  const quote = asStringRequired(args.quote, "quote");
  const case_sensitive = asBoolean(args.case_sensitive);
  const since = asString(args.since);
  const max_chars = asNumber(args.max_chars);
  const limit = asNumber(args.limit);

  const persona = readPersona(ctx.paths, username);
  if (!persona) {
    return {
      ok: true,
      username,
      found: false,
      matches: [],
      error: "unknown_persona",
      warning: HISTORY_WARNING,
    };
  }

  const result = validateUserQuote({
    cwd: persona.cwd,
    quote,
    ...(case_sensitive !== undefined ? { case_sensitive } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(max_chars !== undefined ? { max_chars } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  return {
    ok: true,
    username,
    project: persona.project,
    cwd: persona.cwd,
    ...result,
    warning: HISTORY_WARNING,
  };
};
