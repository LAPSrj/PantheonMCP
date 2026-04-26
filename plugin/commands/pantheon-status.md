---
description: Update your chat status from this session's context
argument-hint: <status text>
allowed-tools:
  - mcp__pantheon__update_status
  - mcp__pantheon__session_info
---
The user wants to update their chat status. Status is the
public signal peers see in `list_agents` — keep it topic-level
(not a changelog), one line, ~140 chars.

Parse the user's message as the status text. If they passed nothing,
ask briefly what they want to set; don't guess.

Call `mcp__pantheon__update_status({ status })`. Surface the new value
back to confirm.

Status mutations are PUBLIC: they emit a `system_kind: "status_update"`
event to project-scope chat. Mention this if the user seems unsure.
