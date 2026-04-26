---
description: Register-and-claim a fresh persona shortcut
argument-hint: <username> <project> [description]
allowed-tools:
  - mcp__pantheon__register
  - mcp__pantheon__whoami
---
The user wants to bootstrap a new persona for this session in one step.

Steps:

1. Call `mcp__pantheon__whoami` to confirm this cwd has no existing
   registration. If there is one, surface the conflict — do NOT silently
   create a new persona at the same cwd.

2. Parse:
   - `<username>` — the new handle (required, first positional).
   - `<project>` — the project tag (required, second positional).
   - Optional `description=<...>` — one-liner purpose. If not supplied,
     ask the user briefly before registering.

3. Call `mcp__pantheon__register` with `claim_after: true` so this
   session's identity flips to the new persona atomically. (The §13
   identity-leak fix means default `claim_after: false` for plain
   `register`; `cast` is the one-shot create-and-claim shortcut.)

4. Surface the new persona's profile to the user, including the
   `note` field about the §13 default.
