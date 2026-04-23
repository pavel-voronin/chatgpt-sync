import { mkdir, readdir } from "node:fs/promises";
import { connect, ensureSingleChatgptTab } from "./cdp";
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
} from "./types";
import { toIsoNow } from "./markdown";

export async function apiMain() {
  const {
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
  } = resolveConfig();

  await mkdir(exportDir, { recursive: true });
  const indexPath = indexFilePath(exportDir);
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
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Runtime.enable");

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
      const exportResult = await exportConversation({
        page,
        chatId: conversationId,
        chatHref: `https://chatgpt.com/c/${conversationId}`,
        exportDir,
        backendHeaders,
        existingRecord: existing ? buildExistingRecord(existing) : undefined,
        usedFileNames: new Set<string>(),
        existingFileNames: new Set(
          (await readdir(exportDir).catch(() => [])).filter((name) =>
            name.endsWith(".md"),
          ),
        ),
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
          sourceUrl: exportResult.href,
          filePath: exportResult.filePath,
          assetDir: exportResult.assetDir,
          sourceUpdateTime:
            existing?.source_update_time ??
            existing?.summary.update_time ??
            null,
          exportedAt: exportResult.exportedAt,
          updatedAt: exportResult.updatedAt,
          assetCount: exportResult.assets,
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
      exportDir,
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
    const sourceUpdateTime = normalizeSourceUpdateTime(summary);
    const shouldMarkPending =
      !existing ||
      existing.status === "pending" ||
      isNewerTimestamp(sourceUpdateTime, existing.source_update_time);

    index.conversations[summary.id] = buildConversationIndexRecord({
      summary,
      sourceUrl: `https://chatgpt.com/c/${summary.id}`,
      filePath: existing?.file_path || "",
      assetDir: existing?.asset_dir || "",
      sourceUpdateTime,
      exportedAt: existing?.exported_at ?? null,
      updatedAt: existing?.updated_at ?? null,
      assetCount: existing?.asset_count ?? 0,
      status: shouldMarkPending ? "pending" : "exported",
    });
  }
}

async function exportPendingConversations(params: {
  page: Awaited<ReturnType<typeof connect>>;
  index: ChatgptIndex;
  indexPath: string;
  exportDir: string;
  backendHeaders: Record<string, string>;
}) {
  const usedFileNames = new Set<string>();
  const existingFileNames = new Set(
    (await readdir(params.exportDir).catch(() => [])).filter((name) =>
      name.endsWith(".md"),
    ),
  );
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
      compareTimestampDesc(left.source_update_time, right.source_update_time),
    );

  for (const [chatId, record] of pending) {
    const chatHref = record.source_url || `https://chatgpt.com/c/${chatId}`;
    const startedAt = toIsoNow();
    console.log(`[export] ${record.summary.title}`);

    const exportResult = await exportConversation({
      page: params.page,
      chatId,
      chatHref,
      exportDir: params.exportDir,
      backendHeaders: params.backendHeaders,
      existingRecord: buildExistingRecord(record),
      usedFileNames,
      existingFileNames,
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
        sourceUrl: exportResult.href,
        filePath: exportResult.filePath,
        assetDir: exportResult.assetDir,
        sourceUpdateTime:
          record.source_update_time ??
          normalizeSourceUpdateTime(record.summary),
        exportedAt: exportResult.exportedAt,
        updatedAt: exportResult.updatedAt,
        assetCount: exportResult.assets,
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
  }

  return exported;
}

function buildExistingRecord(record: ChatgptIndexRecord) {
  if (!record.file_path) {
    return undefined;
  }

  return {
    filePath: record.file_path,
    frontmatter: {
      exported_at: record.exported_at || "",
      updated_at: record.updated_at || "",
    },
  };
}

function normalizeSourceUpdateTime(summary: ConversationSummary) {
  return summary.update_time || null;
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
