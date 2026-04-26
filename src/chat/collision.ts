import { listPersonas, prefixCollision, readPersona } from "../identity/index.ts";
import type { Paths } from "../storage/index.ts";
import type { Subscriber } from "./types.ts";
import type { TombstoneMap } from "./tombstones.ts";

/** Result of `isHandleAvailable`. */
export type AvailabilityResult =
  | { available: true }
  | { available: false; reason: AvailabilityReason; conflicting?: string };

export type AvailabilityReason =
  | "registered_persona"
  | "subscriber_taken"
  | "tombstoned"
  | "registry_prefix_collision"
  | "subscriber_prefix_collision";

const RESERVED = new Set(["admin", "system", "pantheon"]);
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

/** Validate a handle for chat purposes. Mirrors identity validation
 * but allows `.` (some chat handles have dotted forms). Reserved
 * names are rejected. Note: chat allows digit suffixes — those are
 * sibling-incarnation handles (`<base>2`, `<base>3`, …). */
export function validateChatUsername(username: string): { ok: boolean; reason?: string } {
  if (!username || /\s/.test(username)) {
    return { ok: false, reason: "Username must be non-empty and contain no whitespace." };
  }
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      reason: "Username must be 1-48 chars, alphanumeric / _ / - / . starting alphanumeric.",
    };
  }
  if (RESERVED.has(username.toLowerCase())) {
    return { ok: false, reason: `Username '${username}' is reserved (system/admin/pantheon).` };
  }
  return { ok: true };
}

interface AvailabilityArgs {
  username: string;
  /** Already-connected subscribers — typically `state.allSubscribers()`. */
  subscribers: Iterable<Subscriber>;
  tombstones: TombstoneMap;
  paths: Paths;
  /** Set when validating an existing subscriber (e.g. on `update`); allows
   * the caller's own current handle without flagging a self-collision. */
  ignore_self_username?: string;
  /** Set when the caller is a sibling-incarnation candidate (handle
   * matches `<base><N>`) — relaxes the prefix collision against
   * `<base>` per the incarnations rule. */
  is_incarnation_of?: string;
  /** When the calling session has already claimed a persona, that
   * handle is theirs to use in chat too — chat-add must NOT reject
   * `registered_persona` for the owner's own login. Set this to the
   * caller's claimed persona handle (case-sensitive match). */
  claimed_persona?: string;
}

/** §11c composed availability check. Reads persona registry +
 * connected subscribers + tombstones in one pass. */
export function isHandleAvailable(args: AvailabilityArgs): AvailabilityResult {
  const candidate = args.username;
  const candidateLower = candidate.toLowerCase();

  const validation = validateChatUsername(candidate);
  if (!validation.ok) {
    return {
      available: false,
      reason: "registered_persona",
      ...(validation.reason !== undefined ? { conflicting: validation.reason } : {}),
    };
  }

  // 1. Persona registry — exact match. The persona's owner (caller
  // who has already claimed this handle in their session) IS allowed
  // to log into chat as themselves; otherwise this would lock every
  // persona out of chat under their own name.
  const persona = readPersona(args.paths, candidate);
  if (persona && args.claimed_persona !== persona.username) {
    return { available: false, reason: "registered_persona", conflicting: persona.username };
  }

  // 2. Subscribers — exact match.
  for (const sub of args.subscribers) {
    if (args.ignore_self_username && sub.username === args.ignore_self_username) continue;
    if (sub.username.toLowerCase() === candidateLower) {
      return { available: false, reason: "subscriber_taken", conflicting: sub.username };
    }
  }

  // 3. Tombstone — §10 reclaim flow. A tombstone DOES NOT block
  // someone reclaiming the SAME handle within the window — it serves
  // as the trigger for the `handle_recycled` broadcast. Tombstones
  // continue to block prefix collisions from OTHER handles (handled
  // by the prefix walk below), but the exact-name reclaim path
  // proceeds and the caller's responsibility is to invoke
  // `consumeTombstoneAndBroadcast` after the subscriber is added.

  // 4. Prefix collision — registry-side. The persona-owner's own
  // registry entry would otherwise match its own prefix; pass it as
  // ignoreSelf so the owner's chat-add succeeds.
  const registryCollision = prefixCollision(args.paths, candidate, args.claimed_persona);
  if (registryCollision && !isIncarnationOf(candidate, registryCollision, args.is_incarnation_of)) {
    return {
      available: false,
      reason: "registry_prefix_collision",
      conflicting: registryCollision,
    };
  }

  // 5. Prefix collision — subscriber-side.
  const subscriberCollision = subscriberPrefixCollision(
    candidate,
    args.subscribers,
    args.ignore_self_username,
  );
  if (subscriberCollision && !isIncarnationOf(candidate, subscriberCollision, args.is_incarnation_of)) {
    return {
      available: false,
      reason: "subscriber_prefix_collision",
      conflicting: subscriberCollision,
    };
  }

  return { available: true };
}

/** Allow `<base>2` (or `<base>-2` / `<base>_2`) to share a prefix
 * with `<base>` (incarnation relationship) per the §11c sibling-
 * incarnation rule. Both `swoopfinch2` and `swoopfinch-2` count. */
function isIncarnationOf(
  candidate: string,
  conflicting: string,
  declaredBase?: string,
): boolean {
  const candLower = candidate.toLowerCase();
  const confLower = conflicting.toLowerCase();
  const declared = declaredBase?.toLowerCase();
  // Optional `-` or `_` separator between base and digit suffix.
  const re = /^(.+?)[-_]?(\d+)$/;
  const match = re.exec(candLower);
  if (!match) return false;
  const base = match[1]!;
  if (base === confLower) return true;
  if (declared && base === declared && declared === confLower) return true;
  return false;
}

/** Strip a digit-suffix (with optional `-`/`_` separator) from an
 * incarnation handle. `swoopfinch-2` → `swoopfinch`, `swoopfinch` →
 * `swoopfinch` (no change). Used to derive the canonical base when
 * the chat handle is suffixed but the persona registry stays
 * canonical. */
export function incarnationBase(handle: string): string {
  const match = /^(.+?)[-_]?(\d+)$/.exec(handle);
  if (!match) return handle;
  return match[1]!;
}

function subscriberPrefixCollision(
  candidate: string,
  subscribers: Iterable<Subscriber>,
  ignoreSelf?: string,
): string | null {
  const candLower = candidate.toLowerCase();
  const minOwn = Math.min(4, candLower.length);
  for (const sub of subscribers) {
    if (ignoreSelf && sub.username === ignoreSelf) continue;
    const subLower = sub.username.toLowerCase();
    const cmpLen = Math.min(minOwn, subLower.length, 4);
    if (cmpLen < 3) continue;
    if (subLower.slice(0, cmpLen) === candLower.slice(0, cmpLen)) {
      return sub.username;
    }
  }
  return null;
}

/** Lightweight helper used by the §11c chat-router formatters: walks
 * the persona registry once and returns true when at least one
 * persona is registered with the given username. Cheaper than a full
 * `isHandleAvailable` when the caller only needs persona-side existence. */
export function personaExists(paths: Paths, username: string): boolean {
  return listPersonas(paths).some((p) => p.username === username);
}
