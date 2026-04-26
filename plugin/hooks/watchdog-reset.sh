#!/usr/bin/env bash
#
# §14 watchdog reset — fires on every CC tool-use (PreToolUse hook
# with empty matcher). Touches the daemon's per-session watchdog so
# plugin mode gets the richer "any tool-use is activity" signal that
# vanilla MCP can't see (vanilla MCP only sees its own requests).
#
# IMPLEMENTATION NOTE — daemon-side wiring is partial today:
# - The MCP server already touches the watchdog on every CallTool
#   request (vanilla MCP rule §14). That covers the most common
#   case but misses CC's non-MCP tools (Read/Edit/Bash/etc.).
# - This hook is the "richer signal" path. For the single-process
#   MCP server today, there's no clean cross-process channel from
#   the hook (CC's process) to the MCP server (separate process).
# - When the §15 singleton daemon lands, this hook will write a
#   touch event to the daemon's IPC socket; until then it's a
#   best-effort marker file at $PANTHEON_RUNTIME/touch-<sid>.json
#   that the MCP server's daemon-tick can poll.
#
# Today: write a marker file + return success so CC doesn't
# block on us. The MCP server's polling integration is TODO.

set -euo pipefail

# CC pipes a JSON event payload on stdin; we don't currently consume
# it, but drain to avoid blocking the parent.
cat > /dev/null || true

PANTHEON_RUNTIME="${PANTHEON_RUNTIME:-${XDG_STATE_HOME:-$HOME/.local/state}/pantheon/runtime}"
mkdir -p "$PANTHEON_RUNTIME"

# Marker file with PPID so multiple CC sessions don't clobber. The
# MCP server's daemon-tick reads + clears these to drive watchdog.touch.
NOW_MS="$(date +%s%3N)"
MARKER="$PANTHEON_RUNTIME/touch-$PPID.json"
printf '{"pid":%d,"ts_ms":%s,"source":"plugin_pre_tool_use"}' "$PPID" "$NOW_MS" > "$MARKER"

exit 0
