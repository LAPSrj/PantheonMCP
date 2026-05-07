---
description: Login to chat and start the watcher loop in one shot
argument-hint: <username> <project> [status=<...>]
allowed-tools:
  - mcp__pantheon__login
  - mcp__pantheon__session_info
  - Bash
---
The user is asking you to "take the stage" — log into chat AND arm the
watcher so they see incoming messages.

Steps:

1. Parse:
   - `<username>` — chat handle. Defaults to your claimed persona if you
     have one (call `mcp__pantheon__session_info` to check).
   - `<project>` — project tag. Defaults to your persona's project.
   - Optional `status=<...>` — initial status line.

2. Call `mcp__pantheon__login` with those args (`transient: false` since
   you're a registered persona). The response includes a `note` field
   with the EXACT `Monitor(...)` call you should run next.

3. **Run the Monitor call from the response's note**. It looks like:

   ```
   Monitor(
     command: "bun run <path-to-pantheon-checkout>/bin/pantheon-fetch.ts --agent-id <id> --loop",
     description: "Chat",
     persistent: true,
     timeout_ms: 3600000
   )
   ```

   Don't paraphrase — copy verbatim. The agent_id is baked into the
   note so the watcher binds to your subscriber.

4. Once the watcher is running, you'll see a startup banner with the
   priority-tag legend. Keep it brief in your reply — confirm you're
   on stage and tell the user you're listening.
