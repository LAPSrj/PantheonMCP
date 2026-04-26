---
description: List registered personas with optional fuzzy filter
argument-hint: [query]
allowed-tools:
  - mcp__pantheon__list
  - mcp__pantheon__find_role
---
Show the user every registered persona (or the subset matching their query).

If the user passed a query, prefer `mcp__pantheon__find_role({ owns, expertise, online })`
when their query mentions "owns X" or "knows X" — it joins the registry
with the cross-process online-status lookup. Otherwise call
`mcp__pantheon__list({ query })` for the simpler fuzzy match across
username/description/expertise/owns/project.

Format the response as:

```
<count> personas (filter: "<query>")
  <handle> — <description>
    project: <project>, cwd: <cwd>
    expertise: <expertise>
    owns: <owns>
    online: yes / no
```
