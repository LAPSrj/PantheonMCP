# Identity

`src/identity/` owns the persona registry and the §13 session-state
state machine. It is deliberately ignorant of chat: the chat router
(§11c, not yet built) consumes identity data via `prefixCollision` /
`readPersona` / etc., but identity does not call into the router.

## Persona record

A persona is the durable, summonable identity of an agent. It lives at
`personas/<handle>.json` (per `docs/storage.md`) and carries:

- **identity** — `username`, `project`, `cwd`, `platform`, optional
  `wsl_distro`.
- **launch recipe** — `launch_command`, `launch_args`, `mode`
  (`"fresh"` or `"resume"`), `color` (Claude prompt-bar tint).
- **profile** — `description`, `expertise[]`, `owns[]`.
- **server-managed bookkeeping** — `registered_at`,
  `registered_by_pid`, `last_summoned_at`, `last_rested_at`,
  `rest_reason`, `resume_session_id`, `session_name`, `summon_count`,
  `provisional`.

Field renames from summon-mcp:

| summon-mcp        | pantheon          | reason                              |
|-------------------|-------------------|-------------------------------------|
| `last_idled_at`   | `last_rested_at`  | §3c verb rename `idle → rest`.      |
| `idle_reason`     | `rest_reason`     | same.                               |

Pantheon ships no back-compat shim. Existing summon-mcp data is
imported by Leandro's private one-shot before pantheon goes live.

## Username rules

`validateUsername(name)` rejects with a typed `IdentityError`:

| Code                       | When                                             |
|----------------------------|--------------------------------------------------|
| `invalid_username`         | Not 1–48 chars, alphanumeric + `_`/`-`, leading alphanumeric. |
| `reserved_username`        | Lower-cased name is one of `admin`, `system`, `pantheon`. |
| `digit_suffix_reserved`    | Name ends in digits — that suffix space is reserved for sibling incarnations. |

The digit-suffix rule descends from the incarnations plan
(`/home/leandro/summon-mcp-incarnations-plan.md` §1.1). Going forward,
every digit-suffixed handle is by definition an incarnation
(`<base><N>`), so a new persona named `swoopfinch2` would alias the
second incarnation of `swoopfinch` — the registry refuses up front.
Legacy digit-suffixed personas that pre-existed in summon-mcp are NOT
grandfathered here because pantheon has no inherited data; they
either get renamed during Leandro's import script or are imported as
canonical (matching summon-mcp's grandfather rule for legacy entries).

## Prefix collision

`prefixCollision(paths, username, ignoreSelf?)` returns the colliding
existing handle (lower-cased 3–4 char prefix match), or `null`. Uses
the same window as summon-mcp + chat-mcp.

> **Heads up.** §11c specifies the FULL collision check spans three
> sources: registry (this module), connected chat agents (chat router
> subscriber map), and active tombstones (chat router). Identity
> only owns the registry half. The chat router will compose its own
> reads with `prefixCollision` once it lands. Don't add a chat-router
> peek here.

## §13 session-state machine

Three states, modeled as a discriminated union:

```ts
type SessionState =
  | { kind: "unclaimed" }
  | { kind: "claimed_persona"; username: string; resting: boolean }
  | { kind: "guest"; username: string };
```

Transitions are in `src/identity/transitions.ts` — one function per
§13 row. Each function:

1. Performs the registry I/O the doc names FIRST.
2. Mutates the in-memory `Session` SECOND.

If the durable write fails, the session is left untouched. This is
the §13 invariant that closes the `register({ force: true })`
identity-leak.

| Tool                          | Function                       | Default `claim_after` |
|-------------------------------|--------------------------------|-----------------------|
| `claim(u)`                    | `transitionClaim`              | n/a                   |
| `manifest(cwd, hint?)`        | `transitionManifest`           | n/a                   |
| `register(...)`               | `transitionRegister`           | **`false`** (§13 fix) |
| `become(other)`               | `transitionBecome`             | n/a                   |
| `unregister(keep_memory?)`    | `transitionUnregister`         | n/a                   |
| `login(u, transient: true)`   | `transitionLoginGuest`         | n/a                   |
| `login_promote(persona)`      | `transitionPromote`            | n/a                   |
| `rest()` enter / exit         | `transitionRestEnter` / `Exit` | n/a                   |

### Identity-leak fix (§13 / §6)

`transitionRegister`'s `claim_after` defaults to `false`. When a
session is already `claimed_persona(self)` and `register(other)`
runs, the registry mutates but the session's claim does NOT flip —
the function returns a `note` field quoting the §13 wording so the
caller can decide whether to call `claim()` explicitly. Set
`claim_after: true` for the historical conjure-style atomic
create-and-claim.

### `transitionBecome` rollback (doc gap)

§13 says `become(other)` is a "pure claim flip" but is silent on what
to do when `other` isn't registered. Resolved by parity with
`claim`: the registry read happens before the in-memory mutation, so
on `not_registered` the session simply stays at its previous identity
(`note` not needed — the throw is enough). Flagged to semaphoremole
for confirmation; if §13 grows a different rollback rule, only
`transitionBecome` changes.

### `provisional`: conjure vs promote

The `provisional` flag fires for `conjure` only — never for `login_promote`.
The two paths look superficially similar (both create a fresh
persona) but their semantics diverge:

| Path             | Profile fields at create time | `provisional` |
|------------------|-------------------------------|---------------|
| `conjure`        | NOT supplied — the spawned agent calls `update_profile` later. | `true` |
| `login_promote`  | REQUIRED upfront (`description`, `expertise`, `owns`). | `false` |

Conjure is the "spin up a new helper" path: the summoner provides
location + project + a runtime prompt, and the new agent fills in
its own identity. Until the first `update_profile` supplies all three
of `description` / `expertise` / `owns`, the persona is provisional
and the daemon's tool gate refuses everything outside the
identity-completion path. Cleared automatically by `update_profile`.

Promote is the "guest decides to stick around" path: the guest
already chose their handle and lived in the chat for some time;
they're now upgrading to a full persona. They provide complete
profile fields in the `promote` payload so there's no bootstrap gap
to gate. Q10c was specifically about promote — `provisional: true`
is NOT applied there.

Don't conflate the two. Conjure → provisional. Promote → not
provisional.

## Persona forking (§6 MEDIUM)

`forkPersona({ from, to, cwd, copy_memory? })` clones a registered
persona into a fresh handle. The fork is a **snapshot, not a live
mirror** — original and fork mutate independently after the call
returns.

| Inherited from source                                  | Fresh on fork |
|--------------------------------------------------------|---------------|
| `project`, `platform`, `wsl_distro`                    | `cwd` (caller-supplied) |
| `description`, `expertise`, `owns`                     | `registered_at`, `registered_by_pid` |
| `launch_command`, `launch_args`, `mode`, `color`       | `last_summoned_at` (null), `summon_count` (0) |
| `provisional` flag                                     | `last_rested_at` (null), `rest_reason` (null), `resume_session_id` (null) |

`copy_memory` defaults `true`. When set, every entry from the
source's memory store is deep-copied with **regenerated IDs** —
`appendEntry` is called for each entry in turn, so the slugify
pass + collision suffix loop ensure independent ID space. Setting
`false` produces a clean-slate persona with the source's profile
only.

**Chat history is NOT cloned.** Existing `messages` rows reference
the original `agent_id`; the fork's chat participation starts
empty and requires an explicit `login` call. Per §12-H confirmation.

### Collision check (layered)

Two layers, two purposes — kept separate by design:

1. **`forkPersona` (registry-side)** — calls `createPersona`,
   which runs the persona-handle validity rules (regex,
   reserved names, digit-suffix) plus `prefixCollision` against
   every persisted persona. Throws `username_taken_other_cwd` /
   `username_prefix_collision` / `digit_suffix_reserved` /
   `reserved_username` / `invalid_username`.
2. **`fork` MCP handler (chat-side)** — additionally calls
   `ctx.chat?.getByUsername(to)` and throws `username_taken`
   when an online subscriber holds the handle. The chat
   router's `getByUsername` reads through the SQLite presence
   layer, so this check is naturally cross-process.

Refactoring the chat-side check INTO `forkPersona` would mean
threading a `ChatRouter` into the identity layer purely to
check one boolean — cosmetic without behavioral change. The
layered shape is the contract: identity owns registry checks,
the handler composes chat-router checks. Confirmed by
semaphoremole.

### Promote race-loss

`transitionPromote` calls `createPersona` with `force: false`. If a
concurrent writer wins the exclusive create, `createPersona` throws
either `username_taken_other_cwd` or `username_prefix_collision`;
`transitionPromote` translates both into `already_registered` and
the session stays a guest (no rollback needed — nothing else
mutated). Per §10.

## Crash safety

- All persona writes go through `writeJsonAtomic` (tmp + fsync +
  rename(2)).
- Reads tolerate one mid-rename parse retry (`readJson`).
- Multi-writer file paths (memory) use `mutateJsonAtomic` with the
  `(mtimeNs, ino, size)` fingerprint.

Daemon kill -9 mid-claim leaves session state empty on next boot;
the proxy must re-call `claim()` (or `manifest()`). This is the
correct §15 behavior — claims are runtime-only.

## TODO when downstream layers land

- **Chat router (§11c)**: compose `prefixCollision` with subscriber-map
  reads + tombstone reads to form the full `isHandleAvailable`.
- **MCP tool surface (§11b)**: thin wrappers around the transition
  functions; should NOT re-implement state machine rules.
- **Watchdog (§14)**: `transitionRestEnter` is wired; the per-session
  timer + reset triggers belong in `src/watchdog/`.
- **Memory (§4)**: `personas/<handle>/memory.json`. Distinct from
  identity but shares the `mutateJsonAtomic` helper.
- **Conjure**: writes a `provisional: true` persona; the field is
  cleared by the first `update_profile` that supplies all three of
  `description` / `expertise` / `owns`.
