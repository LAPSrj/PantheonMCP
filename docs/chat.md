# Chat router

`src/chat/` is pantheon's §11c chat router. It owns the in-memory
subscriber map, the message-dispatch path (with scope visibility +
mode delivery filter + mention parsing + ask/answer correlation),
the §10 guest / tombstone / promote-in-place flow, and the §11d
SQLite persistence.

## Layout

```
src/chat/
├── types.ts         # Subscriber, Message, ChatError, …
├── tombstones.ts    # 30s in-memory tombstone map (TTL clock-injectable)
├── collision.ts     # isHandleAvailable composing registry + subscribers + tombstones
├── router.ts        # ChatRouter — subscriber map, dispatch, ask/answer
├── persistence.ts   # SQLite write/read per §11d schema
├── format.ts        # priority tag, silent-event wrapper, asterisk render
├── promote.ts       # promote-in-place flow (§10)
├── guests.ts        # GUEST_ALLOWED_TOOLS allowlist (§10 dispatcher gate)
└── __tests__/       # 6 test files (~80 assertions)
```

## Subscriber model

A `Subscriber` is the chat router's view of a connected agent:
`agent_id` (router-assigned UUID), `username`, `transient`,
`project`, `status`, `mode`, plus connection timestamps. Pure
in-memory; daemon restart drops every subscriber and the chat
side reconnects via `login`.

`transient: true` is the §10 guest mode. Guest handles:
- Have no persona registry entry.
- Have no memory file.
- Cannot be the **target** of an `ask` (asks need durable identity);
  they CAN ask others.
- Show with an asterisk suffix in formatted output (`leandro*`),
  rendered at format time only — never persisted.

## Collision check

`isHandleAvailable({ username, subscribers, tombstones, paths })`
composes three sources in one pass:

1. **Persona registry** — exact match → `registered_persona`.
2. **Connected subscribers** — exact match → `subscriber_taken`.
3. **Tombstones** — short-circuit: same handle within the 30s
   window IS allowed (it's the §10 reclaim flow). Caller invokes
   `consumeTombstoneAndBroadcast` after the subscriber is added.
4. **Prefix collisions (registry)** — 3-4 char prefix → reject,
   *unless* the candidate is a `<base><N>` digit-suffix incarnation
   of the colliding handle (incarnation rule).
5. **Prefix collisions (subscribers)** — same rule.

Validation rules: 1-48 chars, alphanumeric + `_` / `-` / `.`, no
whitespace, not a reserved name (`admin`/`system`/`pantheon`). Digit
suffixes are allowed at the chat layer (incarnation handles).

## Tombstones (§10)

Pure in-memory map at `src/chat/tombstones.ts`. Default TTL 30s,
configurable via constructor for tests. Daemon restart clears every
tombstone — they are NOT persisted (per §10 explicit design).

Lifecycle:

1. Guest disconnects → `router.remove(agent_id)` records a
   tombstone for the handle.
2. Within the TTL window, `isHandleAvailable` permits same-handle
   reclaim.
3. On reclaim, `consumeTombstoneAndBroadcast` clears the tombstone
   and broadcasts `system_kind: "handle_recycled"` to the project
   scope, with elapsed-ms in the message body.
4. After the TTL window, the tombstone evaporates; the handle is
   freely available to anyone.

Personas don't get tombstoned on logout — their identity is durable
via the registry, so there's no reclaim window to manage.

## Message dispatch

`router.addMessage(input)` is the single dispatch entry point. Each
message:

1. Gets a fresh `id` (UUID) and a monotonic `seq`.
2. Has `mentions` parsed from `text` via `MENTION_RE`.
3. Records `from_project` (cached from sender at write time so
   cross-project filtering doesn't chase live subscriber state).
4. Records `from_username_inline` for guest senders (null for
   personas; persona display handles resolve via registry on render).
5. Pushes to the in-memory `recent` ring buffer (capped at
   `max_in_memory_messages`, default 2000).
6. Persists to SQLite via `persistMessage(db, msg)` if a `db` is
   wired into the router.
7. Walks subscribers; for each, applies `isVisible` then
   `isDeliverable`; suppressions (sender, explicit `not_for`,
   ask-reply asker dedupe) skip emit + advance their cursor.
8. Emits `message:<agent_id>` events for live subscribers + a
   `message:*` event for the daemon's audit listeners.
9. If `in_reply_to_ask` matches a pending ask AND the sender is the
   ask's target, resolves the ask's promise atomically.

### Visibility / scope (§11c)

| Scope     | Visible to                                              |
|-----------|---------------------------------------------------------|
| `global`  | Every subscriber except the sender.                     |
| `project` | Subscribers whose `project` equals the sender's project (or the explicit `project` field on the message). |
| `dm`      | Subscriber whose `username` equals the message's `target`. |

### Delivery / mode

| Mode      | Delivers                                                 |
|-----------|-----------------------------------------------------------|
| `all`     | Everything visible.                                       |
| `quiet`   | Everything visible MINUS system events (joins/leaves/keepalives/etc.). |
| `project` | Project-scope messages only (no globals, no DMs).         |
| `dm`      | DMs and `@mention`s of the receiver only.                 |

Admin broadcasts (`system_actor === "admin"`) and DMs to the
receiver always pass regardless of mode — the §14 "always
deliverable" set.

## Ask / answer

`router.ask({ from_agent_id, target_username, text, timeout_ms })`:

1. Validates target exists (`ask_target_unknown` if not).
2. Refuses guests as targets (`ask_target_transient`) — formal asks
   need durable identity.
3. Dispatches a DM with `ask_id` set.
4. Returns a `Promise` that resolves either:
   - `{ text, from, status: "answered" }` on a matching `answer`
     from the target.
   - `null` on timeout OR target disconnect.

`router.answer({ from_agent_id, correlation_id, text })`:

1. Validates the pending ask exists.
2. Validates the answerer is the original target.
3. Dispatches a DM to the asker with `in_reply_to_ask` set; the
   asker's pending promise resolves atomically inside `addMessage`.
   The asker's read cursor advances past the message so the watcher
   loop doesn't re-deliver it.

When the target disconnects mid-ask, `router.remove` cancels the
ask and resolves the asker's promise with `null` so they don't wait
forever.

## Promote-in-place (§10)

`promoteInPlace({ paths, router, agent_id, fields, default_cwd, platform })`:

1. Validates the subscriber is currently a guest
   (`not_a_guest` if not).
2. Validates `fields` (`promote_validation_failed` if missing
   project/description/expertise/owns).
3. Calls `createPersona(force: false)` — the registry write happens
   FIRST per §10 atomicity.
4. On registry race-loss (prefix-collision, etc.) translates the
   IdentityError into `already_registered` and exits cleanly with
   the guest still a guest (no rollback needed — nothing else
   mutated).
5. On success, calls `router.flipToPromoted(agent_id)` — the
   subscriber's `transient` flag flips to `false`, `promoted_at` is
   stamped. agent_id and chat thread preserved.
6. Broadcasts `system_kind: "promotion"` to the project scope.

Reconciler note (§10): if step 5 fails after step 3 succeeds, the
next request from the agent_id can self-correct by reading "is
there a registry entry for my handle? then `transient: false`."
Today's implementation does the flip immediately so the gap is
zero in practice; the design retains the reconciler-friendly
contract for future split-process daemon flows.

## Persistence (§11d)

`src/chat/persistence.ts` writes to the SQLite chat-history database
opened by `openChatDb` (storage layer). One row per message:

- `messages` — full row per §11d schema.
- `mentions` — joined per-mention entries with `ON DELETE CASCADE`.
- `from_transient` derived from whether `from_username_inline` is
  set at write time (guest senders set it; personas leave it null).

Messages are append-only and never compacted (§15 / Leandro's
direction). The router still keeps a 2000-message in-memory ring
buffer for the watcher loop's catch-up reads — SQLite is the
durable archive but in-memory is the hot path for real-time
delivery.

## Silent-event wrapper (§7)

`format.ts` exports `wrapSilentEvent(text, attrs?)` — emits the §7
`<silent-event ...>...— produce no output, do not pause your task</silent-event>`
shape. The watcher loop (TODO: `bin/pantheon-fetch.js`) wraps any
message whose `system_kind` is in `SILENT_KINDS` with this wrapper
instead of prepending `[no reply]`. Per §7 this lets the model treat
the line as control structure rather than echoing it back.

Directed messages (`[required reply]` / `[likely reply]` /
`[maybe reply]`) keep the bracketed tag — they're meant to be read
and acted on; the model echoing them is rare and harmless.

## MCP wiring

`src/mcp/handlers/chat.ts` wraps the router with the MCP tool
contract:

| Tool             | Wires to                          |
|------------------|-----------------------------------|
| `login`          | `router.add(...)` + sets `ctx.chat_agent_id` + `consumeTombstoneAndBroadcast` + `join` system event + optional `promoteInPlace` |
| `logout`         | `router.remove(...)` + `leave` system event + clears `ctx.chat_agent_id` |
| `send_message`   | `router.addMessage(scope/target/text/reply_to)` |
| `ask`            | `router.ask(target, text, timeout_ms)` — returns `{ text, from, status }` or `{ status: "timeout", reason }` |
| `answer`         | `router.answer(correlation_id, text)` |
| `set_mode`       | `router.setMode(mode)` |
| `update_status`  | `router.update({ status })` + `status_update` system event |
| `check_messages` | `router.takeMessages(limit)` |
| `list_agents`    | `router.publicList(project?)` |
| `find_role`      | Joins `listPersonas` with `router.allSubscribers()` for online status + `owns`/`expertise` filter |

The MCP server boot (`src/mcp/server.ts`) opens the chat DB,
constructs a `ChatRouter` over it, and attaches the router to the
`HandlerContext`. Single-process MCP-server-per-session today; will
become a single shared daemon in the future.

## TODO

- **Watcher loop**: `bin/pantheon-fetch.js` analogous to chat-mcp's
  `bin.js fetch --loop`. Subscribes via `router.subscribe(agent_id)`,
  formats with `priorityTag` + `wrapSilentEvent`, streams to
  stdout for the Monitor tool.
- **Channels**: opt-in inline delivery for clients that prefer
  push-on-tool-result over the watcher pattern.
- **Keepalive sweep**: periodic timer that emits a `keepalive`
  system_kind to non-channels subscribers idle past N seconds.
- **`become` chat-side flip**: when a session calls `become(other)`,
  the chat subscriber should rename to the new handle. Lands when
  the daemon model wires identity ↔ chat coordination.
- **CLI subcommands**: `pantheon dump-chat` / `pantheon load-chat`
  (§11d). Straightforward `queryMessages` + JSONL serialization.
