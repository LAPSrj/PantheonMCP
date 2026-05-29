export {
  type MemoryEntry,
  type MemoryStore,
  type MemoryStatus,
  type MemoryIndexEntry,
  type MemoryErrorCode,
  MemoryError,
} from "./types.ts";

export {
  appendEntry,
  getEntry,
  updateEntry,
  fadeEntry,
  forgetEntry,
  recallEntry,
  getDetails,
  setMemory,
  listIndex,
  findMemory,
  deriveSummary,
  DETAILS_MAX_BYTES,
  SUMMARY_MAX_CHARS,
  type AppendInput,
  type UpdateInput,
  type ListIndexFilter,
  type FindMemoryFilter,
  type FindMemoryHit,
} from "./operations.ts";

export {
  renderForPrompt,
  renderStore,
  type RenderOptions,
  type RenderResult,
  ACTIVE_BUDGET_BYTES,
  CORE_BUDGET_BYTES,
  CORE_HEAD_KEEP,
  CORE_TAIL_KEEP,
} from "./render.ts";

export { loadStore, mutateStore } from "./store.ts";

export {
  MEMORY_KINDS,
  DURABLE_KINDS,
  TOPIC_REQUIRED_KINDS,
  ALWAYS_TOPIC,
  isV2Kind,
  isLegacyKind,
  mapLegacyKind,
  entryTopic,
  clusterTopics,
  knownTopics,
  type MemoryKind,
  type TopicSummary,
} from "./taxonomy.ts";

export {
  validateWrite,
  type ValidationIssue,
  type ValidateWriteInput,
  type ValidateWriteOptions,
} from "./validation.ts";

export {
  PIN_FULL_BUDGET_BYTES,
  ALWAYS_SUMMARY_BUDGET_BYTES,
  TOPIC_FULL_BUDGET_BYTES,
  NOTES_PER_TOPIC,
} from "./budgets.ts";

export { slugify } from "./derive.ts";

export {
  snapshotMemory,
  restoreMemory,
  listSnapshots,
  deleteSnapshot,
  validateLabel,
  type SnapshotMeta,
} from "./snapshots.ts";

export {
  REFERENCE_KINDS,
  forgetEntryWithLifecycleCoercion,
  type ForgetCoercionResult,
} from "./lifecycle.ts";

export {
  HANDOFF_TTL_MS,
  HANDOFF_KIND,
  defaultHandoffExpiresAt,
  buildHandoffSeed,
  expireEntries,
  expireEntriesFor,
  type HandoffSeed,
} from "./handoffs.ts";
