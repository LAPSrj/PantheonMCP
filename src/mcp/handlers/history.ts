/** Search-history MCP handler.
 *
 * Pantheon doesn't durably store conversation transcripts — CC's
 * JSONL files do. This handler walks them for the current persona
 * and applies a substring / regex filter. The tool description must
 * warn callers loudly: anything they want to recall later goes in
 * memory; CC jsonls can be compacted, deleted, or evicted. */

import { readPersona } from "../../identity/index.ts";
import {
  searchHistory,
  type HistorySearchScope,
  type HistorySearchRole,
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

export const search_history: Handler = async (args, ctx) => {
  const query = asStringRequired(args.query, "query");
  const regex = asBoolean(args.regex) ?? false;
  const case_insensitive = asBoolean(args.case_insensitive) ?? true;
  const scope = asScope(args.scope) ?? "all";
  const role = asRoleFilter(args.role) ?? "all";
  const limit = asNumber(args.limit);
  const since = asString(args.since);

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
      cwd: persona.cwd,
      query,
      regex,
      case_insensitive,
      scope,
      role,
      ...(limit !== undefined ? { limit } : {}),
      ...(since !== undefined ? { since } : {}),
      currentSessionId: ctx.claude_session_id,
    });
    return {
      ok: true,
      query,
      regex,
      scope,
      role,
      current_session_id: ctx.claude_session_id,
      count: hits.length,
      hits,
      warning:
        "Conversation history is NOT durable storage. CC may compact, delete, or evict these jsonl files at any time. Save anything you want to keep with `append_memory`.",
    };
  } catch (err) {
    // Bad regex etc. — surface as invalid_argument.
    throw new ToolError(
      "invalid_argument",
      err instanceof Error ? err.message : String(err),
    );
  }
};
