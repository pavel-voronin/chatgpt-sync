import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_INDEX_SCHEMA_VERSION } from "./config";
import type { ChatgptIndex, ChatgptIndexRecord, ConversationSummary } from "./types";

export function indexFilePath(exportDir: string) {
  return path.join(exportDir, "index.json");
}

export function createEmptyIndex(exportDir: string, conversationsFileLimit: number): ChatgptIndex {
  return {
    schema_version: DEFAULT_INDEX_SCHEMA_VERSION,
    exported_root: exportDir,
    conversations_file_limit: conversationsFileLimit,
    sync: {
      last_sync_at: null,
      last_run_started_at: null,
      last_run_completed_at: null,
      last_run_mode: null,
      last_run_effective_mode: null,
      last_run_page_limit: null,
      last_run_limit: null,
      last_run_days: null,
      last_run_count: null,
      last_run_overlap_minutes: null,
      last_run_selected_count: null,
      last_run_exported_count: null,
      last_run_newest_update_time: null,
      last_run_oldest_update_time: null,
    },
    conversations: {},
  };
}

export async function loadChatgptIndex(
  filePath: string,
  exportDir: string,
  conversationsFileLimit: number,
): Promise<ChatgptIndex> {
  const fallback = createEmptyIndex(exportDir, conversationsFileLimit);
  const text = await readFile(filePath, "utf8").catch(() => "");
  if (!text.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text) as Partial<ChatgptIndex>;
    return {
      ...fallback,
      ...parsed,
      sync: {
        ...fallback.sync,
        ...(parsed.sync || {}),
      },
      conversations: parsed.conversations || {},
    };
  } catch {
    return fallback;
  }
}

export async function saveChatgptIndex(filePath: string, index: ChatgptIndex) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const payload = `${JSON.stringify(index, null, 2)}\n`;
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, filePath);
}

export function buildConversationIndexRecord(params: {
  summary: ConversationSummary;
  sourceUrl: string;
  filePath: string;
  assetDir: string;
  exportedAt: string | null;
  updatedAt: string | null;
  assetCount: number;
  status?: "pending" | "exported";
  lastSeenAt?: string | null;
  lastExportedAt?: string | null;
}): ChatgptIndexRecord {
  const { summary, sourceUrl, filePath, assetDir, exportedAt, updatedAt, assetCount } = params;
  return {
    summary,
    status: params.status || "exported",
    last_seen_at: params.lastSeenAt ?? null,
    last_exported_at: params.lastExportedAt ?? null,
    file_path: filePath,
    asset_dir: assetDir,
    source_url: sourceUrl,
    exported_at: exportedAt,
    updated_at: updatedAt,
    asset_count: assetCount,
  };
}

export function upsertConversationIndex(
  index: ChatgptIndex,
  conversationId: string,
  record: ChatgptIndexRecord,
) {
  index.conversations[conversationId] = record;
}
