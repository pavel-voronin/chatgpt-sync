import path from "node:path";
import type { SyncBootstrapMode, SyncMode } from "./types";

export const DEFAULT_CDP_HTTP = "http://127.0.0.1:9225";
export const DEFAULT_EXPORT_DIR = path.join(process.cwd(), "output");
export const DEFAULT_LIST_LIMIT = 28;
export const DEFAULT_SYNC_MODE: SyncMode = "incremental";
export const DEFAULT_SYNC_COUNT = 50;
export const DEFAULT_SYNC_DAYS = 14;
export const DEFAULT_SYNC_OVERLAP_MINUTES = 60;
export const DEFAULT_SYNC_BOOTSTRAP_COUNT = 50;
export const DEFAULT_SYNC_BOOTSTRAP_DAYS = 14;
export const DEFAULT_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_CONVERSATION_SCHEMA_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 40_000;

function parsePositiveInt(input: string | undefined, fallback: number) {
  const parsed = Number.parseInt(input ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

export function resolveConfig() {
  const cdpHttp = process.env.CHATGPT_CDP_HTTP?.trim() || DEFAULT_CDP_HTTP;
  const exportDir =
    process.env.CHATGPT_EXPORT_DIR?.trim() || DEFAULT_EXPORT_DIR;
  const syncMode = (process.env.CHATGPT_SYNC_MODE?.trim() ||
    DEFAULT_SYNC_MODE) as SyncMode;
  const listLimit = parsePositiveInt(
    process.env.CHATGPT_LIST_LIMIT,
    DEFAULT_LIST_LIMIT,
  );
  const syncCount = parsePositiveInt(
    process.env.CHATGPT_SYNC_COUNT ?? process.env.CHATGPT_EXPORT_LIMIT,
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
  const conversationId = process.env.CHATGPT_CONVERSATION_ID?.trim() || null;

  return {
    cdpHttp,
    exportDir,
    syncMode,
    listLimit,
    syncCount,
    syncDays,
    syncOverlapMinutes,
    bootstrapMode,
    bootstrapCount,
    bootstrapDays,
    conversationId,
  };
}
