export {
  type Scope,
  type Mode,
  type SystemKind,
  type Subscriber,
  type Message,
  type MessageInput,
  type PendingAsk,
  type Tombstone,
  type PublicAgent,
  type ChatErrorCode,
  ChatError,
} from "./types.ts";

export {
  TombstoneMap,
  DEFAULT_TOMBSTONE_MS,
} from "./tombstones.ts";

export {
  isHandleAvailable,
  validateChatUsername,
  personaExists,
  type AvailabilityResult,
  type AvailabilityReason,
} from "./collision.ts";

export {
  ChatRouter,
  parseMentions,
  type RouterOptions,
} from "./router.ts";

export {
  persistMessage,
  queryMessages,
  type QueryFilter,
  type MessageRow,
} from "./persistence.ts";

export {
  upsertSubscriber,
  heartbeat,
  removeSubscriber,
  listActive,
  pruneStale,
  totalSubscribers,
  DEFAULT_STALE_THRESHOLD_MS,
  DEFAULT_PRUNE_GRACE_MS,
  type PresenceRow,
} from "./presence.ts";

export {
  priorityTag,
  wrapSilentEvent,
  SILENT_KINDS,
  renderSender,
  modeMarker,
  guestMarker,
  type PriorityTag,
} from "./format.ts";

export {
  promoteInPlace,
  type PromoteFields,
} from "./promote.ts";

export {
  GUEST_ALLOWED_TOOLS,
  isGuestAllowed,
} from "./guests.ts";
