---
description: Run pantheon doctor — paths, schema, presence health check
allowed-tools:
  - Bash
---
The user wants a sanity check on their pantheon installation.

Run:

```
pantheon doctor
```

(Or, if `pantheon` isn't on the PATH, the equivalent
`bun run <path-to-pantheon-checkout>/bin/pantheon.ts doctor`.)

Surface the exit code:
- 0 → HEALTHY (info lines + maybe warnings, no errors)
- 1 → ISSUES (errors listed; surface each verbatim)

If errors include `chat.db schema version`, the daemon needs a fresh
boot to apply pending migrations — suggest restarting any running
`pantheon serve` processes.
