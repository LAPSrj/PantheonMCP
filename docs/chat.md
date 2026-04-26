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

## Cross-process presence (path 4a)

Per §11c the chat router needs to publish presence across MCP
processes — without this `list_agents` would only see the agents
sharing this MCP server's process, breaking the chat-mcp parity
goal. The implementation: a SQLite-backed presence table that
every MCP process upserts to on subscriber lifecycle events and
heartbeats every 5 seconds.

### Table

```sql
CREATE TABLE subscribers (
  agent_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  project TEXT NOT NULL,
  transient INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT '',
  connected_at INTEGER NOT NULL,
  status_updated_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  promoted_at INTEGER
);
```

Schema migration v2 ships in `src/storage/sqlite.ts`. Indexed on
`username`, `project`, and `last_heartbeat DESC` so the hot path
(`list_agents` filtered by recent heartbeat + optional project) is
a covered scan.

### Write-through

`ChatRouter.add` / `remove` / `update` / `setMode` /
`flipToPromoted` write through to the presence table when a `db`
is wired. Best-effort: a presence write failure never aborts the
in-memory router op — the in-memory dispatch path keeps working;
cross-process visibility just stays stale until the next
successful upsert.

### Heartbeat

The MCP server boot installs a `setInterval(5_000)` that calls
`router.heartbeat(ctx.chat_agent_id)` whenever a chat session is
active. The 5s cadence sits well below the 30s stale-threshold
default — a missed beat or two won't evict the row from
`list_agents`.

### Stale + prune thresholds

| Constant | Value | Used for |
|----------|-------|----------|
| `DEFAULT_STALE_THRESHOLD_MS` | 30_000 | `listActive` hides rows whose `last_heartbeat` is older. |
| `DEFAULT_PRUNE_GRACE_MS` | 60_000 | `pruneStale` deletes rows older than this — longer than the stale threshold so a momentarily-late heartbeat doesn't get the row deleted, just hidden. |

The MCP server boot installs a second `setInterval(30_000)` daemon
tick that calls `pruneStale(db)` and `tombstones.prune()` so a
single timer drives both sweeps.

### Read

`router.publicList(project?)` and `router.onlineUsernames()` read
from the presence table when a `db` is wired and fall back to the
in-memory subscriber map when one isn't (test harnesses with
`new ChatRouter({ paths })`). Both call paths converge on the same
shape — callers don't need to know which source delivered the data.

`list_agents` and `find_role` MCP handlers use these methods, so
their cross-process behavior is automatic once the presence table
is wired.

## Why "reclaim allows broadcast" instead of "30s lockout"

§10 reads ambiguously on whether a same-handle reclaim within the
window is *blocked* or *permitted-with-broadcast*. Pantheon
implements permitted-with-broadcast for two reasons:

1. **Network-blip resilience** — Yapsmith's stated intent for the
   tombstone window is "the agent's MCP just dropped and is
   reconnecting." Hard-blocking the reclaim defeats that case.
2. **Handle continuity > 30s lockout** — DM threads and `@mention`
   semantics break when the same human-recognizable handle keeps
   getting a fresh anonymous identity. Letting the same handle
   come back with a `handle_recycled` broadcast preserves
   continuity AND surfaces the seam to peers.

Different actor grabbing the handle in-window is also permitted —
the broadcast tells peers "this handle just changed hands"; their
DM logic can treat it as a routing signal. Confirmed against
Yapsmith's spec via semaphoremole 2026-04-25.

If a future failure mode argues for hard-block instead, the
single-line change is in `src/chat/collision.ts`: re-instate the
tombstone-rejects branch.

## Ask disconnect vs ask timeout (two distinct shapes)

`ask` resolves to one of three outcomes:

| Outcome | Shape | When |
|---------|-------|------|
| Answered | `{ status: "answered", text, from }` | Target called `answer(correlation_id, text)` before the timeout. |
| Timeout (still connected) | `null` resolve in the asker's tool return; tool surfaces `{ status: "timeout", reason }`. (Future: synthetic-answer DM with `in_reply_to_ask`.) | Target stayed connected but didn't answer within `timeout_ms`. |
| Respondent disconnect | `null` resolve in the asker's tool return; tool surfaces `{ status: "timeout", reason: "respondent_disconnected_or_no_response" }`. NO synthetic answer in chat history. | Target disconnected (`logout` / watchdog / daemon-side detect) before answering. |

The disconnect path deliberately does NOT write a synthetic answer
into chat history — that would pollute the audit trail with messages
the target never sent. The asker's tool return is the only signal,
and a future `ask({ on_disconnect: "synthetic_answer" })` toggle can
opt back into the chat-history shape if a use case appears.

Approved by semaphoremole 2026-04-25 against §12-H ("don't make the
asker wait forever") — the spirit is satisfied either way; the
disconnect shape is cleaner.

## Watcher loop (`bin/pantheon-fetch.ts`)

The watcher is pantheon's analogue to chat-mcp's
`bin.js fetch --loop`: a CLI process that long-polls the chat
history database, filters per the receiver's mode/scope, formats
events with priority tags or `<silent-event>` wrappers, and writes
one line per event to stdout. Stderr is reserved for diagnostics
(banner, fatal errors) so the Monitor tool can treat stdout as a
pure event stream.

### CLI

```
pantheon-fetch --agent-id <id> [--loop] [--wait <ms>] [--mode <m>] [--coalesce <ms>]
```

| Flag           | Default | Notes |
|----------------|---------|-------|
| `--agent-id`   | (req'd) | Subscriber id to receive events for. Comes from `login`'s response. |
| `--loop`       | off     | Long-poll forever; default is one-shot read. |
| `--wait`       | 500ms   | Poll interval when no new rows. Min 50ms. |
| `--mode`       | (none)  | Override receiver's stored mode: `all` / `quiet` / `project` / `dm`. |
| `--coalesce`   | 1000ms  | Silent-event coalesce window. |

The 500ms `--wait` default is the sweet spot per chat-mcp's
operational experience: anything <250ms is wasteful (busy SQLite
loop with no payoff); anything >2s feels laggy in DM threads.

### Watcher cursor strategy

**Cursor is `seq` (integer), not `ts` (wall-clock).** Three reasons:

1. **`ts` collisions** — two messages within the same millisecond
   share `ts`; the cursor would need an `(ts, id)` tuple with a
   tiebreak rule. Awkward + fragile.
2. **`seq` is naturally a single integer**, monotonic, trivially
   comparable. Matches today's chat-mcp pattern.
3. **`seq` indexes cleanly** — the v3 schema migration adds
   `idx_messages_seq` so the watcher's hot query (`WHERE seq > ?
   ORDER BY seq ASC LIMIT N`) is a covered scan.

But: with multiple MCP processes writing to the same chat.db, an
in-process `seq` counter would issue duplicates. The seq must come
from SQLite itself.

**Implementation: SQLite-managed seq via `INSERT INTO messages (...,
seq, ...) VALUES (..., (SELECT COALESCE(MAX(seq), 0) + 1 FROM
messages), ...)` inside a transaction.** SQLite WAL serializes
writes so the SELECT + INSERT pair is atomic; cross-process writers
can't issue duplicate seqs. The router pre-assigns a per-process
seq for in-memory dispatch (which still needs a value before
persistence), then `persistMessage` overrides with the SQLite-
assigned value and returns it; the router updates the in-memory
copy so dispatch + cursor + watcher all agree on the same seq.

In-memory-only routers (test harnesses with no `db`) keep the
per-process counter — the cross-process consistency only matters
when the db is wired.

Cursor lives in-memory in the watcher process. On startup the
watcher reads `MAX(seq)` from messages and starts there — no
history replay. (Future: optional `--since-seq <N>` flag for
backfill scenarios.)

### Filter pipeline

Per iteration, the watcher:

1. Reads receivable rows past `lastSeq` via `selectReceivableRows`,
   which combines:
   - `from_agent_id != receiver.agent_id` (suppress own messages)
   - `isVisibleRow` (scope rules — global / project-match / dm-match)
   - `isDeliverableRow` (mode rules + always-deliverable for
     keepalives/admin/personal mentions/DMs)
   - mention-bypass: a single batch SELECT into the `mentions`
     table for the receiver's username gates the mention check
2. Formats each row via `priorityTag` (directed messages) or
   coalesces into `<silent-event>` (ambient events whose `kind`
   is in `SILENT_KINDS`).
3. Coalesces silent events within `--coalesce` ms into one
   `<silent-event count=N kind=...>` line per window. Non-silent
   events flush the buffer first so silent flurries never push past
   a directed message.
4. If no new rows, sleeps `--wait` ms.
5. Refreshes the receiver row from the presence table every 5s so
   `set_mode` calls from elsewhere take effect mid-loop.

### Exit conditions

- `SIGTERM` / `SIGINT` — abort the loop, flush pending silent
  buffer, close the db, exit 0.
- `SessionExpiredError` — the receiver's presence row was deleted
  (logout / heartbeat lapsed past the prune grace). Watcher exits
  3 with a stderr message instructing the caller to re-login + re-
  spawn.
- DB close from another process — surfaces as an exception; watcher
  exits 1.

### Coalescing

Silent ambient events flow in flurries during boot or restart. The
watcher buffers them up to `--coalesce` ms (default 1s) then emits a
single `<silent-event time=HH:MM:SS count=N>2× join, 1× leave |
latest: ...</silent-event>` line. This keeps stdout from flooding
when many sessions reconnect simultaneously. Directed messages
flush the silent buffer first so they don't get coalesced into
ambient noise.

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

- ~~**Watcher loop**~~ — landed in commit `bf88225`. See "Watcher
  loop (bin/pantheon-fetch.ts)" section above.
- **Channels**: opt-in inline delivery for clients that prefer
  push-on-tool-result over the watcher pattern.
- **Keepalive sweep**: periodic timer that emits a `keepalive`
  system_kind to non-channels subscribers idle past N seconds.
- **`become` chat-side flip**: when a session calls `become(other)`,
  the chat subscriber should rename to the new handle. Lands when
  the daemon model wires identity ↔ chat coordination.
- **CLI subcommands**: `pantheon dump-chat` / `pantheon load-chat`
  (§11d). Straightforward `queryMessages` + JSONL serialization.
