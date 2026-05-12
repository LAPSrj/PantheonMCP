export {
  NotebookError,
  PAGE_BODY_WARN_BYTES,
  SLUG_RE,
  TITLE_MAX_CHARS,
  TOPIC_TOTAL_WARN_BYTES,
  type NotebookErrorCode,
  type NotebookPage,
  type NotebookPageStatus,
  type NotebookStore,
  type NotebookTopic,
  type NotebookTopicRef,
} from "./types.ts";

export { loadNotebookStore, mutateNotebookStore } from "./store.ts";

export {
  deletePage,
  deleteTopic,
  getPage,
  listTopics,
  openTopic,
  renameTopic,
  restorePage,
  searchNotebook,
  searchStore,
  writePage,
  type OpenTopicResult,
  type SearchHit,
  type SearchOptions,
  type WritePageInput,
  type WritePageResult,
} from "./operations.ts";
