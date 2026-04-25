import path from "node:path";
import type { AssetStrategy, SyncBootstrapMode, SyncMode } from "./types";

export const DEFAULT_CDP_HTTP = "http://127.0.0.1:9222";
export const DEFAULT_EXPORT_DIR = path.join(process.cwd(), "output");
export const DEFAULT_LIST_LIMIT = 28;
export const DEFAULT_SYNC_MODE: SyncMode = "incremental";
export const DEFAULT_SYNC_COUNT = 50;
export const DEFAULT_SYNC_DAYS = 14;
export const DEFAULT_SYNC_OVERLAP_MINUTES = 60;
export const DEFAULT_SYNC_BOOTSTRAP_COUNT = 50;
export const DEFAULT_SYNC_BOOTSTRAP_DAYS = 14;
export const DEFAULT_LIST_PAGE_DELAY_MS = 1_000;
export const DEFAULT_LIST_PAGE_JITTER_MS = 1_000;
export const DEFAULT_EXPORT_BATCH_LIMIT = 10;
export const DEFAULT_EXPORT_START_DELAY_MS = 2_000;
export const DEFAULT_BACKEND_LOCK_MINUTES = 10;
export const DEFAULT_ASSET_STRATEGY: AssetStrategy = "fixed-folder";
export const DEFAULT_ASSET_SUBDIR = "assets";
export const DEFAULT_FIXED_ASSET_DIR = "assets";
export const DEFAULT_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_CONVERSATION_SCHEMA_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 40_000;

function parseBoolean(input: string | undefined): boolean {
  const value = input?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function parsePositiveInt(input: string | undefined, fallback: number) {
  const parsed = Number.parseInt(input ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(input: string | undefined, fallback: number) {
  const parsed = Number.parseInt(input ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBootstrapMode(
  input: string | undefined,
): SyncBootstrapMode | null {
  const value = input?.trim();
  if (!value) {
    return null;
  }
  if (value === "count" || value === "days" || value === "full") {
    return value;
  }
  throw new Error(`Invalid CHATGPT_SYNC_BOOTSTRAP_MODE value: ${value}`);
}

function parseAssetStrategy(input: string | undefined): AssetStrategy {
  const value = input?.trim();
  if (!value) {
    return DEFAULT_ASSET_STRATEGY;
  }
  if (
    value === "vault-root" ||
    value === "same-folder" ||
    value === "current-folder-subfolder" ||
    value === "fixed-folder"
  ) {
    return value;
  }
  throw new Error(`Invalid CHATGPT_SYNC_ASSET_STRATEGY value: ${value}`);
}

function resolveWorkspacePath(root: string, candidate: string) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Path must stay inside workspace: ${absoluteCandidate} is outside ${absoluteRoot}`,
    );
  }
  return absoluteCandidate;
}

function resolveChildPath(root: string, candidate: string, fallback: string) {
  const value = candidate.trim() || fallback;
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, value);
  return resolveWorkspacePath(root, resolved);
}

export function resolveConfig() {
  const cdpHttp = process.env.CHATGPT_SYNC_CDP_HTTP?.trim() || DEFAULT_CDP_HTTP;
  const workspaceDir =
    process.env.CHATGPT_SYNC_WORKSPACE_DIR?.trim() || DEFAULT_EXPORT_DIR;
  const inboxDir = resolveChildPath(
    workspaceDir,
    process.env.CHATGPT_SYNC_INBOX_DIR?.trim() || "",
    ".",
  );
  const assetStrategy = parseAssetStrategy(
    process.env.CHATGPT_SYNC_ASSET_STRATEGY,
  );
  const assetSubdir =
    process.env.CHATGPT_SYNC_ASSET_SUBDIR?.trim() || DEFAULT_ASSET_SUBDIR;
  const fixedAssetDir = resolveChildPath(
    workspaceDir,
    process.env.CHATGPT_SYNC_ASSET_FIXED_DIR?.trim() || "",
    DEFAULT_FIXED_ASSET_DIR,
  );
  const syncMode = (process.env.CHATGPT_SYNC_MODE?.trim() ||
    DEFAULT_SYNC_MODE) as SyncMode;
  const listLimit = parsePositiveInt(
    process.env.CHATGPT_SYNC_LIST_LIMIT,
    DEFAULT_LIST_LIMIT,
  );
  const listPageDelayMs = parseNonNegativeInt(
    process.env.CHATGPT_SYNC_LIST_PAGE_DELAY_MS,
    DEFAULT_LIST_PAGE_DELAY_MS,
  );
  const listPageJitterMs = parseNonNegativeInt(
    process.env.CHATGPT_SYNC_LIST_PAGE_JITTER_MS,
    DEFAULT_LIST_PAGE_JITTER_MS,
  );
  const syncCount = parsePositiveInt(
    process.env.CHATGPT_SYNC_COUNT,
    DEFAULT_SYNC_COUNT,
  );
  const syncDays = parsePositiveInt(
    process.env.CHATGPT_SYNC_DAYS,
    DEFAULT_SYNC_DAYS,
  );
  const syncOverlapMinutes = parsePositiveInt(
    process.env.CHATGPT_SYNC_OVERLAP_MINUTES,
    DEFAULT_SYNC_OVERLAP_MINUTES,
  );
  const bootstrapMode = parseBootstrapMode(
    process.env.CHATGPT_SYNC_BOOTSTRAP_MODE,
  );
  const bootstrapCount = parsePositiveInt(
    process.env.CHATGPT_SYNC_BOOTSTRAP_COUNT,
    DEFAULT_SYNC_BOOTSTRAP_COUNT,
  );
  const bootstrapDays = parsePositiveInt(
    process.env.CHATGPT_SYNC_BOOTSTRAP_DAYS,
    DEFAULT_SYNC_BOOTSTRAP_DAYS,
  );
  const conversationId =
    process.env.CHATGPT_SYNC_CONVERSATION_ID?.trim() || null;
  const renderUnknownPartsAsJson = parseBoolean(
    process.env.CHATGPT_SYNC_RENDER_UNKNOWN_PARTS_AS_JSON,
  );
  const dumpRawConversationJson = parseBoolean(
    process.env.CHATGPT_SYNC_DUMP_RAW_CONVERSATION_JSON,
  );
  const exportBatchLimit = parsePositiveInt(
    process.env.CHATGPT_SYNC_EXPORT_BATCH_LIMIT,
    DEFAULT_EXPORT_BATCH_LIMIT,
  );
  const exportStartDelayMs = parseNonNegativeInt(
    process.env.CHATGPT_SYNC_EXPORT_START_DELAY_MS,
    DEFAULT_EXPORT_START_DELAY_MS,
  );
  const backendLockMinutes = parseNonNegativeInt(
    process.env.CHATGPT_SYNC_BACKEND_LOCK_MINUTES,
    DEFAULT_BACKEND_LOCK_MINUTES,
  );

  return {
    cdpHttp,
    workspaceDir,
    inboxDir,
    assetStrategy,
    assetSubdir,
    fixedAssetDir,
    syncMode,
    listLimit,
    listPageDelayMs,
    listPageJitterMs,
    syncCount,
    syncDays,
    syncOverlapMinutes,
    bootstrapMode,
    bootstrapCount,
    bootstrapDays,
    conversationId,
    renderUnknownPartsAsJson,
    dumpRawConversationJson,
    exportBatchLimit,
    exportStartDelayMs,
    backendLockMinutes,
  };
}
