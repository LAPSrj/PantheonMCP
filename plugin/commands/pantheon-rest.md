---
description: Save state and put this session to rest (replaces summon-mcp /idle)
argument-hint: [reason] [handoff_for=<username>] [handoff_text=<...>]
allowed-tools:
  - mcp__pantheon__rest
  - mcp__pantheon__allow_rest
  - mcp__pantheon__exit
  - mcp__pantheon__append_memory
---
The user is asking you to wind down this session.

Before calling `mcp__pantheon__rest`:

1. **Save anything future-you needs** via `mcp__pantheon__append_memory`.
   Decisions made, files modified, what you were mid-doing, integration
   points. Be specific, summary ≤240 chars, body ~500-2KB. Use
   `core: true` for foundational handoff knowledge.

2. **If this is a non-summoned session** and the user hasn't authorized
   rest already, call `mcp__pantheon__allow_rest` first.

3. **If the user is handing off to a specific peer**, parse
   `handoff_for=<username>` + `handoff_text=<...>` from the args and
   pass them to `rest({ handoff: { for, text } })`. The handoff slot
   writes a `kind: "handoff"` core memory entry with a 7-day TTL AND
   DMs the target with the text.

4. **Call `rest`**, surface the response, then **call `exit`** with a
   brief delay so the user sees your goodbye before SIGTERM closes the tab.
