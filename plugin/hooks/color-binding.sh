#!/usr/bin/env bash
#
# /color binding — fires after the user runs CC's /color command.
# Reads the chosen color from session_info via pantheon's MCP and
# persists it to the claimed persona via update_profile.
#
# This hook is best-effort. CC's /color writes to its own session
# state file; we read THAT file (CC doesn't expose color via hook
# stdin) and call into pantheon to mirror the choice.

set -euo pipefail

# Drain stdin (CC sends a JSON event payload).
cat > /dev/null || true

PANTHEON_BIN="${PANTHEON_BIN:-}"
CLAUDE_SESSIONS_DIR="${CLAUDE_SESSIONS_DIR:-$HOME/.claude/sessions}"

# Find the most recent session JSON for this CC process.
LATEST="$(ls -t "$CLAUDE_SESSIONS_DIR"/*.json 2>/dev/null | head -n1 || true)"
if [ -z "$LATEST" ]; then
  exit 0
fi

# Parse via bun (strictly typed). The pantheon CLI doesn't currently
# expose a `bind-color` subcommand — this hook is a placeholder that
# documents intent. When CC's per-session color exposure is stable
# (or the §15 daemon model lands with proper hook wiring), wire this
# to call `pantheon update-profile --color <X>` directly.

# Today: no-op exit success.
exit 0
