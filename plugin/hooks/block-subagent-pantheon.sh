#!/usr/bin/env bash
#
# Block the pantheon tool surface for SUBAGENTS.
#
# A Claude Code subagent (Task/Agent-tool spawn) runs in the parent's
# process and inherits its full `PANTHEON_*` env (PANTHEON_USERNAME,
# PANTHEON_PROFILE, ...). It therefore reaches the SAME pantheon MCP
# connection AS THE SAME PERSONA as the main agent. The MCP server
# resolves identity once per process (server.ts) and every tool call
# runs against one shared ctx — so pantheon cannot tell a subagent's
# call from the main agent's, and cannot block it server-side. The
# only enforcement point is here, at the harness, before the call is
# routed.
#
# We deny ALL `mcp__pantheon__*` calls that originate from a subagent.
# A subagent is NOT the persona: it must not read or write the
# persona's memory, act in chat, or drive lifecycle (login/rest/exit/
# summon) under the persona's identity. (Motivating case: agents
# spawning subagents to "summarize my memory" — the subagent read the
# persona's full memory as the persona.)
#
# SIGNAL: a PreToolUse hook payload carries top-level `agent_type` /
# `agent_id` ONLY when the call comes from a subagent; both are absent
# for the main agent. (Claude Code hooks, 2.1.160.) We key off
# `agent_type`. The main agent passes through untouched.
#
# Registered with matcher `mcp__pantheon__.*`, so it only runs for
# pantheon calls — the main agent's non-pantheon tools never hit it.

set -euo pipefail

payload="$(cat || true)"

# Extract the top-level `agent_type`. Prefer jq (correct, top-level
# only); fall back to a best-effort key match when jq is absent.
agent_type=""
if command -v jq >/dev/null 2>&1; then
  agent_type="$(printf '%s' "$payload" | jq -r '.agent_type // empty' 2>/dev/null || true)"
elif printf '%s' "$payload" | grep -Eq '"agent_type"[[:space:]]*:[[:space:]]*"[^"]+"'; then
  agent_type="subagent"
fi

if [ -n "$agent_type" ]; then
  # Deny via the PreToolUse permission-decision JSON. The reason is
  # surfaced as hook feedback.
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pantheon tools are unavailable to subagents. A subagent shares the parent persona's identity, so it must not read or write the persona's memory, act in chat, or change lifecycle. Have the MAIN agent perform any pantheon work (e.g. read/summarize memory) and pass the result down through the task prompt."}}
JSON
  exit 0
fi

# Main agent (no subagent signal) — allow.
exit 0
