export {
  resolvePaths,
  personaFilePath,
  memoryFilePath,
  notebookFilePath,
  personaDir,
  projectMemoryFilePath,
  projectMemoryDir,
  projectNotebookFilePath,
  ensureProjectMemoryDir,
  ensureProjectNotebookDir,
  ensureDataDirs,
  ensureStateDirs,
  ensurePersonaDir,
  legacyPaths,
  findStrandedLegacy,
  assertNoLegacyLayout,
  LegacyLayoutError,
  type Paths,
  type LegacyLayout,
} from "./paths.ts";

export {
  writeJsonAtomic,
  readJson,
  mutateJsonAtomic,
  StorageError,
} from "./json.ts";

export { openChatDb, CURRENT_SCHEMA_VERSION } from "./sqlite.ts";
