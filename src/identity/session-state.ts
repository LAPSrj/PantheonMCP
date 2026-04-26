/** §13 session-state machine.
 *
 * A session is in exactly one state at any time:
 *   - `unclaimed` — fresh session, no identity yet.
 *   - `claimed_persona(u)` — adopted a registered persona (registry
 *     entry + memory + summonable + cwd-anchored).
 *   - `guest(u, transient: true)` — chat-only handle, no registry
 *     entry, no memory.
 *
 * The persona-claim half lives in the daemon's per-session map; the
 * guest half is mirrored from the chat router's subscriber map (which
 * owns the durable record of being-online-as-guest). For test +
 * reasoning purposes we model both halves in one tagged union.
 */
export type SessionState =
  | { kind: "unclaimed" }
  | { kind: "claimed_persona"; username: string; resting: boolean }
  | { kind: "guest"; username: string };

export class Session {
  readonly id: string;
  private _state: SessionState;

  constructor(id: string, initial?: SessionState) {
    this.id = id;
    this._state = initial ?? { kind: "unclaimed" };
  }

  get state(): SessionState {
    return this._state;
  }

  get claimedUsername(): string | null {
    return this._state.kind === "claimed_persona" ? this._state.username : null;
  }

  get guestUsername(): string | null {
    return this._state.kind === "guest" ? this._state.username : null;
  }

  get isResting(): boolean {
    return this._state.kind === "claimed_persona" && this._state.resting;
  }

  /** Low-level state setter used by transition functions. Direct
   * callers should prefer the §13 transition wrappers in
   * `transitions.ts` so the atomicity story is preserved. */
  _setState(next: SessionState): void {
    this._state = next;
  }
}
