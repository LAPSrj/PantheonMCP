/** §13 identity / session-state transitions.
 *
 * Each transition function composes a session-state mutation with the
 * relevant registry I/O in the order §13 prescribes. Atomicity rules
 * spelled out per case: durable writes happen FIRST so a failed write
 * never leaves stale in-memory claim state behind.
 *
 * The §13 transitions table is the contract; if a transition's
 * behavior here disagrees with §13, the doc is the source of truth
 * and this file is the bug.
 */

import type { Paths } from "../storage/index.ts";
import {
  createPersona,
  deletePersona,
  personasForCwd,
  readPersona,
} from "./registry.ts";
import type { Session } from "./session-state.ts";
import { IdentityError, type Persona, type PersonaCreate } from "./types.ts";

export interface ManifestMatch {
  persona: Persona;
  reason: "sole-match" | "hint-match";
}

export interface ManifestAmbiguous {
  matches: Persona[];
  hint?: string;
}

/** §13 `claim(u)` — Pure session mutation; no registry write. Errors
 * if `u` is not registered. */
export function transitionClaim(
  paths: Paths,
  session: Session,
  username: string,
): Persona {
  const persona = readPersona(paths, username);
  if (!persona) {
    throw new IdentityError(
      "not_registered",
      `Cannot claim '${username}' — no registration found.`,
    );
  }
  session._setState({ kind: "claimed_persona", username: persona.username, resting: false });
  return persona;
}

/** §13 `manifest(cwd, hint?)` — Reads registry by cwd; mutates session
 * only on a single match (or a hint that uniquely disambiguates).
 *
 * Returns one of:
 *   - `{ matched: persona, reason }` on auto-claim
 *   - `{ ambiguous: { matches, hint } }` when human disambiguation is
 *     needed (the caller surfaces the candidate list)
 *   - `{ none: true }` when no persona owns this cwd
 */
export type ManifestResult =
  | { matched: ManifestMatch }
  | { ambiguous: ManifestAmbiguous }
  | { none: true };

export function transitionManifest(
  paths: Paths,
  session: Session,
  cwd: string,
  hint?: string,
): ManifestResult {
  const matches = personasForCwd(paths, cwd);
  if (matches.length === 0) return { none: true };
  if (matches.length === 1) {
    const persona = matches[0]!;
    session._setState({ kind: "claimed_persona", username: persona.username, resting: false });
    return { matched: { persona, reason: "sole-match" } };
  }
  if (hint) {
    const hintLower = hint.toLowerCase();
    const hintMatches = matches.filter((p) => {
      if (p.username.toLowerCase().includes(hintLower)) return true;
      if (p.description.toLowerCase().includes(hintLower)) return true;
      if (p.expertise.some((e) => e.toLowerCase().includes(hintLower))) return true;
      if (p.owns.some((o) => o.toLowerCase().includes(hintLower))) return true;
      return false;
    });
    if (hintMatches.length === 1) {
      const persona = hintMatches[0]!;
      session._setState({ kind: "claimed_persona", username: persona.username, resting: false });
      return { matched: { persona, reason: "hint-match" } };
    }
  }
  return { ambiguous: hint !== undefined ? { matches, hint } : { matches } };
}

export interface RegisterOptions {
  force?: boolean;
  /** §13 / §6 identity-leak fix: default `false`. When `false`,
   * `register` ONLY mutates the registry; the calling session's
   * claim is left untouched. Set `true` to opt into the historical
   * conjure-style atomic create-and-claim. */
  claim_after?: boolean;
  pid?: number;
  now?: () => number;
}

export interface RegisterResult {
  persona: Persona;
  claimed: boolean;
  /** Surfaced to the caller. When `claim_after: false` the note
   * names the registered handle and the session's unchanged claim
   * — quoting §13 wording. */
  note?: string;
}

/** §13 `register(...)` — Registry write FIRST. Session-claim flip
 * SECOND, only when `claim_after: true`. The default is `false`
 * (identity-leak fix per §6 / §13). */
export function transitionRegister(
  paths: Paths,
  session: Session,
  input: PersonaCreate,
  opts: RegisterOptions = {},
): RegisterResult {
  const claimAfter = opts.claim_after ?? false;
  const createOpts: { force?: boolean; pid?: number; now?: () => number } = {};
  if (opts.force !== undefined) createOpts.force = opts.force;
  if (opts.pid !== undefined) createOpts.pid = opts.pid;
  if (opts.now !== undefined) createOpts.now = opts.now;
  const persona = createPersona(paths, input, createOpts);

  if (claimAfter) {
    session._setState({ kind: "claimed_persona", username: persona.username, resting: false });
    return { persona, claimed: true };
  }

  const currentClaim = session.claimedUsername;
  if (currentClaim && currentClaim !== persona.username) {
    return {
      persona,
      claimed: false,
      note: `registered '${persona.username}'; your session identity remains '${currentClaim}'; call claim() to switch.`,
    };
  }
  return { persona, claimed: false };
}

/** §13 `become(other)` — Pure claim flip.
 *
 * The brainstorm doc is silent on rollback when `other` is not
 * registered. Resolved by parity with `claim`: the registry read
 * happens before the in-memory mutation, so on `not_registered` the
 * session simply stays at its previous identity (no rollback needed).
 *
 * Flagged to semaphoremole 2026-04-25 for confirmation; this is a
 * conservative, no-op-on-failure default. If §13 grows a different
 * rollback rule, only this function changes. */
export function transitionBecome(
  paths: Paths,
  session: Session,
  username: string,
): Persona {
  if (session.state.kind !== "claimed_persona") {
    throw new IdentityError(
      "no_persona",
      "become requires a claimed persona — call claim() or manifest() first.",
    );
  }
  const persona = readPersona(paths, username);
  if (!persona) {
    throw new IdentityError(
      "not_registered",
      `Cannot become '${username}' — no registration found. Your session remains '${session.state.username}'.`,
    );
  }
  session._setState({ kind: "claimed_persona", username: persona.username, resting: false });
  return persona;
}

/** §13 `unregister(self, keep_memory)` — Registry delete FIRST, then
 * session-claim clear. */
export function transitionUnregister(
  paths: Paths,
  session: Session,
  opts: { keep_memory?: boolean } = {},
): { unregistered: string } {
  if (session.state.kind !== "claimed_persona") {
    throw new IdentityError(
      "no_persona",
      "unregister requires a claimed persona.",
    );
  }
  const username = session.state.username;
  deletePersona(paths, username, { dropMemory: !(opts.keep_memory ?? false) });
  session._setState({ kind: "unclaimed" });
  return { unregistered: username };
}

/** §13 / §10 `login_promote` — Guest → persona.
 *
 * Atomicity: registry write happens FIRST with `force: false` so a
 * concurrent writer that won the exclusive-create race causes the
 * promote to fail with `already_registered` and the session stays
 * a guest (no rollback needed — nothing else mutated yet). On
 * success, the session flips to `claimed_persona` and the chat-side
 * subscriber-map flip + `system_kind: "promotion"` broadcast fall to
 * the chat router. */
export function transitionPromote(
  paths: Paths,
  session: Session,
  fields: PersonaCreate,
  opts: { pid?: number; now?: () => number } = {},
): Persona {
  if (session.state.kind !== "guest") {
    throw new IdentityError(
      "no_persona",
      "promote requires a guest session (login with transient: true first).",
    );
  }
  if (fields.username !== session.state.username) {
    throw new IdentityError(
      "invalid_username",
      `promote handle '${fields.username}' must match the current guest handle '${session.state.username}'.`,
    );
  }
  let persona: Persona;
  const createOpts: { force?: boolean; pid?: number; now?: () => number } = { force: false };
  if (opts.pid !== undefined) createOpts.pid = opts.pid;
  if (opts.now !== undefined) createOpts.now = opts.now;
  try {
    persona = createPersona(paths, fields, createOpts);
  } catch (err) {
    if (
      err instanceof IdentityError &&
      (err.code === "username_taken_other_cwd" ||
        err.code === "username_prefix_collision")
    ) {
      // Race-loss: another writer won the exclusive create. §10 says
      // guest stays guest, no rollback (nothing else mutated).
      throw new IdentityError(
        "already_registered",
        `Handle '${fields.username}' was registered by another writer; remaining a guest.`,
        { underlying: err.code },
      );
    }
    throw err;
  }
  session._setState({ kind: "claimed_persona", username: persona.username, resting: false });
  return persona;
}

/** §10 `login(u, transient: true)` — guest. Registry-side check only;
 * the chat router owns the subscriber-map insert + tombstone read.
 * Throws `already_registered` if `u` is a registered persona. */
export function transitionLoginGuest(
  paths: Paths,
  session: Session,
  username: string,
): { username: string } {
  if (session.state.kind !== "unclaimed") {
    throw new IdentityError(
      "already_registered",
      "login(transient: true) requires an unclaimed session.",
    );
  }
  const existing = readPersona(paths, username);
  if (existing) {
    throw new IdentityError(
      "already_registered",
      `Handle '${username}' is a registered persona; cannot join as guest. Use claim() to adopt it instead.`,
    );
  }
  // NOTE: §11c collision check (subscriber map + tombstones) lives in
  // the chat router. The router will compose with `prefixCollision`
  // from the registry and reject before reaching this function on a
  // duplicate-online or tombstoned handle.
  session._setState({ kind: "guest", username });
  return { username };
}

/** §14 rest entry. Session enters quiescent mode; claim unchanged. */
export function transitionRestEnter(session: Session): void {
  if (session.state.kind !== "claimed_persona") {
    throw new IdentityError(
      "no_persona",
      "rest requires a claimed persona.",
    );
  }
  session._setState({ ...session.state, resting: true });
}

/** Wake from rest. Watchdog reset triggers and explicit return-to-
 * activity calls flip this back to false. */
export function transitionRestExit(session: Session): void {
  if (session.state.kind !== "claimed_persona") return;
  if (!session.state.resting) return;
  session._setState({ ...session.state, resting: false });
}
