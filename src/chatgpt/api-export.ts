import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  connect,
  ensureSingleChatgptTab,
  initializeChatgptSession,
} from "./cdp";
import { resolveConfig } from "./config";
import {
  buildConversationIndexRecord,
  indexFilePath,
  loadChatgptIndex,
  saveChatgptIndex,
  upsertConversationIndex,
} from "./index-store";
import { exportConversation } from "./conversation-export";
import { planConversationSummaries } from "./list-scan";
import type {
  ChatgptIndex,
  ChatgptIndexRecord,
  ConversationSummary,
  ConversationSyncStatus,
} from "./types";
import { readExistingRecords, toIsoNow } from "./markdown";

export async function apiMain() {
  const {
    cdpHttp,
    workspaceDir,
    inboxDir,
    assetStrategy,
    assetSubdir,
    fixedAssetDir,
    syncMode,
    listLimit,
    syncCount,
    syncDays,
    syncOverlapMinutes,
    bootstrapMode,
    bootstrapCount,
    bootstrapDays,
    conversationId,
  } = resolveConfig();

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(inboxDir, { recursive: true });
  const indexPath = indexFilePath(workspaceDir);
  const initialIndex = await loadChatgptIndex(indexPath);

  if (!initialIndex.watermark && !bootstrapMode) {
    throw new Error(
      "CHATGPT_SYNC_BOOTSTRAP_MODE must be set before the first scan can run",
    );
  }

  const version = (await fetch(`${cdpHttp}/json/version`).then((res) =>
    res.json(),
  )) as {
    webSocketDebuggerUrl?: string;
  };
  if (!version.webSocketDebuggerUrl) {
    throw new Error(`Missing CDP websocket URL at ${cdpHttp}`);
  }

  const tab = await ensureSingleChatgptTab(cdpHttp);
  const page = await connect(tab.webSocketDebuggerUrl);
  await initializeChatgptSession(page);

  let backendHeaders: Record<string, string> | null = null;
  const offHeaders = page.on("Network.requestWillBeSentExtraInfo", (params) => {
    if (backendHeaders) {
      return;
    }
    const headers = params.headers as Record<string, string> | undefined;
    const targetPath = String(
      headers?.["x-openai-target-path"] ||
        headers?.["X-OpenAI-Target-Path"] ||
        "",
    );
    if (headers && targetPath.startsWith("/backend-api/")) {
      backendHeaders = headers;
    }
  });

  try {
    if (!tab.url.includes("chatgpt.com")) {
      await page.send("Page.navigate", { url: "https://chatgpt.com/" });
    }
    if (!backendHeaders) {
      await page.send("Page.reload", { ignoreCache: true });
      const startedAt = Date.now();
      while (!backendHeaders && Date.now() - startedAt < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!backendHeaders) {
      throw new Error(
        "Could not capture backend API headers from the active browser tab",
      );
    }

    if (conversationId) {
      const existing = initialIndex.conversations[conversationId];
      const filesystem = await readExistingRecords(workspaceDir);
      const exportResult = await exportConversation({
        page,
        chatId: conversationId,
        chatHref: `https://chatgpt.com/c/${conversationId}`,
        workspaceDir,
        inboxDir,
        assetStrategy,
        assetSubdir,
        fixedAssetDir,
        backendHeaders,
        existingRecord: filesystem.records.get(conversationId),
        usedMarkdownPaths: new Set<string>(),
        existingMarkdownPaths: filesystem.markdownPaths,
        titleHint: existing?.summary.title,
        exportStartedAt: toIsoNow(),
      });

      upsertConversationIndex(
        initialIndex,
        conversationId,
        buildConversationIndexRecord({
          summary: {
            ...(existing?.summary || exportResult.summary),
            title: exportResult.title,
            update_time: existing?.summary.update_time,
          },
          updatedAt: exportResult.updatedAt,
          status: "exported",
        }),
      );
      await saveChatgptIndex(indexPath, initialIndex);

      console.log(
        JSON.stringify(
          [
            {
              title: exportResult.title,
              filePath: exportResult.filePath,
              href: exportResult.href,
              turns: exportResult.turns,
              assets: exportResult.assets,
            },
          ],
          null,
          2,
        ),
      );
      return;
    }

    const scanPlan = await planConversationSummaries(page, {
      mode: syncMode,
      pageLimit: listLimit,
      countLimit: syncCount,
      daysLimit: syncDays,
      overlapMinutes: syncOverlapMinutes,
      watermark: initialIndex.watermark,
      bootstrapMode,
      bootstrapCount,
      bootstrapDays,
      requestHeaders: backendHeaders,
    });

    const scanCompletedAt = toIsoNow();
    applyConversationScan(initialIndex, scanPlan.items);
    initialIndex.watermark = scanCompletedAt;
    await saveChatgptIndex(indexPath, initialIndex);

    console.log(
      JSON.stringify(
        {
          scan: {
            mode: scanPlan.mode,
            effectiveMode: scanPlan.effectiveMode,
            selectedCount: scanPlan.selectedCount,
            scannedPages: scanPlan.scannedPages,
            cutoffAt: scanPlan.cutoffAt,
            watermark: initialIndex.watermark,
          },
        },
        null,
        2,
      ),
    );

    const index = await loadChatgptIndex(indexPath);
    const exported = await exportPendingConversations({
      page,
      index,
      indexPath,
      workspaceDir,
      inboxDir,
      assetStrategy,
      assetSubdir,
      fixedAssetDir,
      backendHeaders,
    });

    await saveChatgptIndex(indexPath, index);
    console.log(JSON.stringify(exported, null, 2));
  } finally {
    offHeaders();
    page.close();
  }
}

function applyConversationScan(
  index: ChatgptIndex,
  items: ConversationSummary[],
) {
  for (const summary of items) {
    const existing = index.conversations[summary.id];
    const shouldMarkPending =
      !existing ||
      existing.status === "pending" ||
      isNewerTimestamp(
        summary.update_time || null,
        existing.summary.update_time || null,
      );

    const nextStatus = resolveConversationStatus(
      existing?.status,
      shouldMarkPending,
    );

    index.conversations[summary.id] = buildConversationIndexRecord({
      summary,
      updatedAt: existing?.updated_at ?? null,
      status: nextStatus,
    });
  }
}

async function exportPendingConversations(params: {
  page: Awaited<ReturnType<typeof connect>>;
  index: ChatgptIndex;
  indexPath: string;
  workspaceDir: string;
  inboxDir: string;
  assetStrategy: ReturnType<typeof resolveConfig>["assetStrategy"];
  assetSubdir: string;
  fixedAssetDir: string;
  backendHeaders: Record<string, string>;
}) {
  const filesystem = await readExistingRecords(params.workspaceDir);
  const usedMarkdownPaths = new Set<string>();
  const exported: Array<{
    title: string;
    filePath: string;
    href: string;
    turns: number;
    assets: number;
  }> = [];

  const pending = Object.entries(params.index.conversations)
    .filter(([, record]) => record.status === "pending")
    .sort(([, left], [, right]) =>
      compareTimestampDesc(
        left.summary.update_time || null,
        right.summary.update_time || null,
      ),
    );

  for (const [chatId, record] of pending) {
    const existingRecord = filesystem.records.get(chatId);
    if (
      !existingRecord &&
      record.status === "pending" &&
      wasPreviouslyExported(record)
    ) {
      upsertConversationIndex(
        params.index,
        chatId,
        buildConversationIndexRecord({
          summary: record.summary,
          updatedAt: record.updated_at,
          status: "removed",
        }),
      );
      await saveChatgptIndex(params.indexPath, params.index);
      continue;
    }

    const chatHref = `https://chatgpt.com/c/${chatId}`;
    const startedAt = toIsoNow();
    console.log(`[export] ${record.summary.title}`);

    const exportResult = await exportConversation({
      page: params.page,
      chatId,
      chatHref,
      workspaceDir: params.workspaceDir,
      inboxDir: params.inboxDir,
      assetStrategy: params.assetStrategy,
      assetSubdir: params.assetSubdir,
      fixedAssetDir: params.fixedAssetDir,
      backendHeaders: params.backendHeaders,
      existingRecord,
      usedMarkdownPaths,
      existingMarkdownPaths: filesystem.markdownPaths,
      titleHint: record.summary.title,
      exportStartedAt: startedAt,
    });

    upsertConversationIndex(
      params.index,
      chatId,
      buildConversationIndexRecord({
        summary: {
          ...record.summary,
          title: exportResult.title,
        },
        updatedAt: exportResult.updatedAt,
        status: "exported",
      }),
    );
    await saveChatgptIndex(params.indexPath, params.index);

    exported.push({
      title: exportResult.title,
      filePath: exportResult.filePath,
      href: exportResult.href,
      turns: exportResult.turns,
      assets: exportResult.assets,
    });
    console.log(
      `[done] ${exportResult.title} turns=${exportResult.turns} assets=${exportResult.assets}`,
    );
    filesystem.records.set(chatId, {
      filePath: path.resolve(exportResult.filePath),
      frontmatter: {
        conversation_id: chatId,
        updated_at: exportResult.updatedAt,
      },
    });
    filesystem.markdownPaths.add(path.resolve(exportResult.filePath));
  }

  return exported;
}

function isNewerTimestamp(current: string | null, previous: string | null) {
  if (!current) {
    return false;
  }
  if (!previous) {
    return true;
  }

  const currentTime = new Date(current).getTime();
  const previousTime = new Date(previous).getTime();
  if (!Number.isFinite(currentTime)) {
    return false;
  }
  if (!Number.isFinite(previousTime)) {
    return true;
  }
  return currentTime > previousTime;
}

function compareTimestampDesc(left: string | null, right: string | null) {
  const leftTime = left ? new Date(left).getTime() : Number.NEGATIVE_INFINITY;
  const rightTime = right
    ? new Date(right).getTime()
    : Number.NEGATIVE_INFINITY;
  return rightTime - leftTime;
}

function resolveConversationStatus(
  currentStatus: ConversationSyncStatus | undefined,
  shouldMarkPending: boolean,
): ConversationSyncStatus {
  if (currentStatus === "removed") {
    return "removed";
  }
  return shouldMarkPending ? "pending" : "exported";
}

function wasPreviouslyExported(record: ChatgptIndexRecord) {
  return record.status === "exported" || record.updated_at !== null;
}
