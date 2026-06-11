export {
  resolvePaths,
  personaFilePath,
  memoryFilePath,
  personaDir,
  projectMemoryFilePath,
  projectMemoryDir,
  projectConfigFilePath,
  projectsRootDir,
  listProjectDirNames,
  ensureProjectMemoryDir,
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

export {
  readProjectConfig,
  writeProjectConfig,
  isProjectSingleAgent,
  setProjectSingleAgent,
  setProjectDescription,
  assertValidProjectName,
  MAX_PROJECT_DESCRIPTION,
  type ProjectConfig,
} from "./project-config.ts";
