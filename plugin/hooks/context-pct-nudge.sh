#!/usr/bin/env bash
#
# §6 HIGH auto-context-percent nudge. Fires on every UserPromptSubmit.
# Reads CC's current context percentage (via the session JSON or a
# future CC-exposed env var) and emits a chat DM to the persona at
# 70% / 85% / 95% thresholds.
#
# Threshold ladder per §6 HIGH:
#   70% — soft hint: "consider saving state via append_memory"
#   85% — strong nudge: "save state + handoff if you'll continue"
#   95% — "save NOW + rest before you're auto-compacted"
#
# Today: no-op stub. Reading context-pct from CC requires either
# CC exposing it via hook payload (future CC feature) or a per-
# session JSON parse (path varies by CC version). Wire this when
# either path stabilizes.

set -euo pipefail

# Drain stdin so we don't block CC.
cat > /dev/null || true

# Future implementation outline:
#
# 1. Read context-pct from $PANTHEON_CONTEXT_PCT env (set by CC plugin
#    integration when available), or fall back to parsing the latest
#    session JSON's `usage` field.
# 2. Look up our claimed persona via pantheon's session_info.
# 3. Read the previous-fired threshold from a per-session marker file
#    so we don't re-fire each turn.
# 4. If a new threshold is crossed, call `pantheon` to send a chat DM
#    to ourselves (or to a designated handoff target) using the
#    matching template from src/responses/templates/.
#
# All four steps require either daemon IPC or a long-lived MCP call
# from the hook process — neither shipped yet. Stub returns success
# so CC doesn't block.

exit 0
