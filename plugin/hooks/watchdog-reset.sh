#!/usr/bin/env bash
#
# §14 plugin-mode watchdog reset. Fires from CC's PreToolUse hook
# on every tool-use event (Read/Edit/Bash/etc. — anything CC wraps
# in a tool call). Vanilla MCP only sees its own requests; this
# hook is the "richer signal" path that catches non-MCP CC
# activity so an actively-working agent doesn't auto-rest.
#
# Protocol — touch a marker file the pantheon MCP server's daemon-
# tick polls every 5s:
#
#   ~/.pantheon/sessions/<ppid>/last_tool_use_at
#
# Where <ppid> is the CC parent process pid (always equal between
# the hook and the MCP server since CC is the parent of both).
#
# The file's MTIME is the signal — contents are irrelevant. The
# server's HookPoller compares mtime against its last-seen and
# calls `watchdog.touch(session_id)` when it advances. Cross-MCP
# coordination via filesystem; no IPC needed today.
#
# Stale dirs (no tool-use for >1hr) are swept at MCP server boot.

set -euo pipefail

# Drain stdin (CC pipes a JSON event payload; we don't need it).
cat > /dev/null || true

# Resolve the storage root. Pantheon consolidates to a single
# `~/.pantheon/` folder (no XDG split). PANTHEON_HOME overrides the
# default for test sandboxes.
if [ -n "${PANTHEON_HOME:-}" ]; then
  STATE_ROOT="$PANTHEON_HOME"
else
  STATE_ROOT="$HOME/.pantheon"
fi

SESSION_DIR="$STATE_ROOT/sessions/$PPID"
mkdir -p "$SESSION_DIR"
# `touch` is the wire format — mtime advance is the signal.
touch "$SESSION_DIR/last_tool_use_at"

exit 0
