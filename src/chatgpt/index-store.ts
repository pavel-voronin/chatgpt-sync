import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChatgptIndex,
  ChatgptIndexRecord,
  ConversationSummary,
} from "./types";

export function indexFilePath(workspaceDir: string) {
  return path.join(workspaceDir, "index.json");
}

export function createEmptyIndex(): ChatgptIndex {
  return {
    watermark: null,
    backend_lock_until: null,
    backend_lock_reason: null,
    conversations: {},
  };
}

export async function loadChatgptIndex(
  filePath: string,
): Promise<ChatgptIndex> {
  const fallback = createEmptyIndex();
  const text = await readFile(filePath, "utf8").catch(() => "");
  if (!text.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(text) as Partial<ChatgptIndex>;
    return {
      ...fallback,
      ...parsed,
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
  updatedAt: string | null;
  status?: ChatgptIndexRecord["status"];
}): ChatgptIndexRecord {
  const { summary, updatedAt } = params;
  return {
    summary,
    status: params.status || "exported",
    updated_at: updatedAt,
  };
}

export function upsertConversationIndex(
  index: ChatgptIndex,
  conversationId: string,
  record: ChatgptIndexRecord,
) {
  index.conversations[conversationId] = record;
}
