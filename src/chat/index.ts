export {
  type Scope,
  type Mode,
  type SystemKind,
  type Subscriber,
  type StatusMeta,
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
  renderStatusDigest,
  type RouterOptions,
} from "./router.ts";

export {
  appendAudit,
  auditPath,
  isAuditEnabled,
} from "./audit.ts";

export {
  persistMessage,
  queryMessages,
  getMessageById,
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
  readChatCursor,
  advanceChatCursor,
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

export {
  selectReceivableRows,
  isVisibleRow,
  isDeliverableRow,
  formatBatch,
  tailOnce,
  tailLoop,
  readMaxSeq,
  SessionExpiredError,
  DEFAULT_BATCH_SIZE,
  DEFAULT_WAIT_MS,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_RECEIVER_REFRESH_MS,
  type ReceiverState,
  type TailOptions,
  type WatcherEvent,
  type LoopOptions,
} from "./watcher.ts";
