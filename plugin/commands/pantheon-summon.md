---
description: Summon a registered persona into a new tab/window/split
argument-hint: <username> [target=split|new-tab-here|new-tab-window|new-window]
allowed-tools:
  - mcp__pantheon__summon
  - mcp__pantheon__list
---
You're being asked to summon a registered pantheon persona.

Parse the user's message for:
- `<username>` — the persona to summon (required; first positional argument).
- Optional `target=<mode>` shorthand: `split` → `{mode: "split-pane"}`,
  `new-tab-here` / `new-tab-window` / `new-window` → corresponding mode.
- Optional `prompt=<...>` — runtime prompt forwarded to the spawned agent.

Call `mcp__pantheon__summon` with those arguments. If the persona doesn't
exist (`not_registered`), call `mcp__pantheon__list` with the user's argument
as a `query` to surface near-matches and offer to register a new persona.

Surface the spawn pid + tab title back to the user. If the spawn returned a
`note` field (downgrade ladder triggered), pass that along too.
