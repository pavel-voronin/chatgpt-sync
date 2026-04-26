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
import { isBackendRequestError } from "./errors";
import {
  planConversationSummaries,
  type ConversationScanProgress,
} from "./list-scan";
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
    backendHeadersTimeoutMs,
  } = resolveConfig();

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(inboxDir, { recursive: true });
  const indexPath = indexFilePath(workspaceDir);
  const initialIndex = await loadChatgptIndex(indexPath);
  console.log(
    `[init] workspace=${workspaceDir} mode=${conversationId ? "single" : syncMode}`,
  );

  if (await exitIfBackendLocked(indexPath, initialIndex)) {
    return;
  }

  if (!initialIndex.watermark && !bootstrapMode) {
    throw new Error(
      "CHATGPT_SYNC_BOOTSTRAP_MODE must be set before the first scan can run",
    );
  }

  console.log(`[cdp] connecting to ${cdpHttp}`);
  const version = (await fetch(`${cdpHttp}/json/version`).then((res) =>
    res.json(),
  )) as {
    webSocketDebuggerUrl?: string;
  };
  if (!version.webSocketDebuggerUrl) {
    throw new Error(`Missing CDP websocket URL at ${cdpHttp}`);
  }

  const tab = await ensureSingleChatgptTab(cdpHttp);
  console.log(`[cdp] using tab ${tab.url}`);
  const page = await connect(tab.webSocketDebuggerUrl);
  await initializeChatgptSession(page);

  let backendHeaders: Record<string, string> | null = null;
  const backendRequestIds = new Set<string>();
  const offRequests = page.on("Network.requestWillBeSent", (params) => {
    const requestId = String(params.requestId ?? "");
    const request = params.request as
      | { url?: string; headers?: Record<string, string> }
      | undefined;
    if (!requestId || !isBackendApiUrl(request?.url || "")) {
      return;
    }
    backendRequestIds.add(requestId);
    backendHeaders = mergeHeaders(backendHeaders, request?.headers);
  });
  const offHeaders = page.on("Network.requestWillBeSentExtraInfo", (params) => {
    const headers = params.headers as Record<string, string> | undefined;
    if (!headers) {
      return;
    }
    const requestId = String(params.requestId ?? "");
    const targetPath = String(
      headers?.["x-openai-target-path"] ||
        headers?.["X-OpenAI-Target-Path"] ||
        "",
    );
    if (
      backendRequestIds.has(requestId) ||
      targetPath.startsWith("/backend-api/")
    ) {
      backendHeaders = mergeHeaders(backendHeaders, headers);
    }
  });

  try {
    await prepareChatgptBackendHeaders({
      page,
      initialUrl: tab.url,
      timeoutMs: backendHeadersTimeoutMs,
      getBackendHeaders: () =>
        hasBackendHeaderContext(backendHeaders) ? backendHeaders : null,
    });
    const capturedBackendHeaders = backendHeaders;
    if (!hasBackendHeaderContext(capturedBackendHeaders)) {
      throw new Error(
        "Could not capture backend API headers from the active browser tab",
      );
    }

    if (conversationId) {
      console.log(`[single] exporting conversation ${conversationId}`);
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
        backendHeaders: capturedBackendHeaders,
        existingRecord: filesystem.records.get(conversationId),
        usedMarkdownPaths: new Set<string>(),
        existingMarkdownPaths: filesystem.markdownPaths,
        titleHint: existing?.summary.title,
        exportStartedAt: toIsoNow(),
        renderUnknownPartsAsJson,
        dumpRawConversationJson,
      });
      const syncedAt = maxTimestampIso(
        toIsoNow(),
        existing?.summary.update_time || null,
      );

      upsertConversationIndex(
        initialIndex,
        conversationId,
        buildConversationIndexRecord({
          summary: {
            ...(existing?.summary || exportResult.summary),
            title: exportResult.title,
            update_time: existing?.summary.update_time,
          },
          updatedAt: syncedAt,
          status: "exported",
        }),
      );
      await saveChatgptIndex(indexPath, initialIndex);

      console.log(
        `[done] ${exportResult.title} turns=${exportResult.turns} assets=${exportResult.assets}`,
      );
      return;
    }

    console.log(
      `[scan] reading conversation list effectiveMode=${initialIndex.watermark ? syncMode : bootstrapMode} pageLimit=${listLimit} pageDelayMs=${listPageDelayMs} pageJitterMs=${listPageJitterMs}`,
    );
    let savedScanSummaries = 0;
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
      pageDelayMs: listPageDelayMs,
      pageJitterMs: listPageJitterMs,
      requestHeaders: capturedBackendHeaders,
      onPageItems: async (items) => {
        applyConversationScan(initialIndex, items);
        await saveChatgptIndex(indexPath, initialIndex);
        savedScanSummaries += items.length;
        console.log(
          `[scan] saved ${items.length} conversation summaries totalSaved=${savedScanSummaries}`,
        );
      },
      onProgress: (progress) => {
        console.log(formatScanProgress(progress));
      },
      onPageDelay: (delayMs, nextOffset) => {
        console.log(
          `[wait] ${delayMs}ms before list page offset=${nextOffset}`,
        );
      },
    }).catch((error) => {
      console.error(
        `[scan] failed after saving ${savedScanSummaries} conversation summaries; watermark was not advanced`,
      );
      throw error;
    });

    const scanCompletedAt = toIsoNow();
    console.log(
      `[scan] completed selected=${scanPlan.selectedCount} pages=${scanPlan.scannedPages}`,
    );
    initialIndex.watermark = scanCompletedAt;
    await saveChatgptIndex(indexPath, initialIndex);

    const index = await loadChatgptIndex(indexPath);
    console.log("[export] checking pending conversations");
    await exportPendingConversations({
      page,
      index,
      indexPath,
      workspaceDir,
      inboxDir,
      assetStrategy,
      assetSubdir,
      fixedAssetDir,
      backendHeaders: capturedBackendHeaders,
      renderUnknownPartsAsJson,
      dumpRawConversationJson,
      batchLimit: exportBatchLimit,
      startDelayMs: exportStartDelayMs,
    });

    await saveChatgptIndex(indexPath, index);
  } catch (error) {
    if (isBackendRequestError(error)) {
      await lockBackend(indexPath, initialIndex, backendLockMinutes, error);
    }
    throw error;
  } finally {
    offRequests();
    offHeaders();
    page.close();
  }
}

function isBackendApiUrl(url: string) {
  try {
    const parsed = new URL(url, "https://chatgpt.com");
    return (
      parsed.hostname.endsWith("chatgpt.com") &&
      parsed.pathname.startsWith("/backend-api/")
    );
  } catch {
    return false;
  }
}

function mergeHeaders(
  current: Record<string, string> | null,
  next: Record<string, string> | undefined,
) {
  if (!next) {
    return current;
  }
  return {
    ...(current || {}),
    ...next,
  };
}

function hasBackendHeaderContext(
  headers: Record<string, string> | null,
): headers is Record<string, string> {
  if (!headers) {
    return false;
  }
  return Boolean(
    getHeader(headers, "cookie") &&
    getHeader(headers, "authorization") &&
    getHeader(headers, "oai-client-build-number"),
  );
}

function getHeader(headers: Record<string, string>, name: string) {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName && value) {
      return value;
    }
  }
  return "";
}

async function prepareChatgptBackendHeaders(params: {
  page: Awaited<ReturnType<typeof connect>>;
  initialUrl: string;
  timeoutMs: number;
  getBackendHeaders: () => Record<string, string> | null;
}) {
  if (!params.initialUrl.includes("chatgpt.com")) {
    console.log("[browser] opening https://chatgpt.com/");
    await params.page.send("Page.navigate", { url: "https://chatgpt.com/" });
  } else {
    await params.page.send("Page.reload", { ignoreCache: true });
  }

  console.log(
    `[browser] waiting for backend API headers timeoutMs=${params.timeoutMs}`,
  );
  const startedAt = Date.now();
  let lastProbeAt = 0;
  while (
    !params.getBackendHeaders() &&
    Date.now() - startedAt < params.timeoutMs
  ) {
    const currentUrl = await currentPageUrl(params.page);
    const now = Date.now();
    if (currentUrl.includes("chatgpt.com") && now - lastProbeAt >= 1_000) {
      lastProbeAt = now;
      await probeBackendHeaders(params.page);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function currentPageUrl(page: Awaited<ReturnType<typeof connect>>) {
  const result = (await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: "window.location.href",
  })) as { result?: { value?: string } };
  return result.result?.value || "";
}

async function probeBackendHeaders(page: Awaited<ReturnType<typeof connect>>) {
  await page
    .send("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: `fetch("/backend-api/conversations?offset=0&limit=1&order=updated&is_archived=false&is_starred=false", { credentials: "include" }).then(() => true).catch(() => false)`,
    })
    .catch(() => undefined);
}

async function exitIfBackendLocked(indexPath: string, index: ChatgptIndex) {
  const lockedUntil = parseIsoTime(index.backend_lock_until || null);
  if (!lockedUntil) {
    return false;
  }

  const now = Date.now();
  if (lockedUntil > now) {
    console.log(
      `[lock] backend locked until ${index.backend_lock_until}; reason=${index.backend_lock_reason || "unknown"}`,
    );
    return true;
  }

  index.backend_lock_until = null;
  index.backend_lock_reason = null;
  await saveChatgptIndex(indexPath, index);
  console.log("[lock] expired backend lock cleared");
  return false;
}

async function lockBackend(
  indexPath: string,
  index: ChatgptIndex,
  lockMinutes: number,
  error: Error & { status?: number | null },
) {
  const lockUntil = new Date(Date.now() + lockMinutes * 60_000).toISOString();
  const latestIndex = await loadChatgptIndex(indexPath).catch(() => index);
  latestIndex.backend_lock_until = lockUntil;
  latestIndex.backend_lock_reason = error.message;
  await saveChatgptIndex(indexPath, latestIndex);
  console.error(
    `[lock] backend locked until ${lockUntil} for ${lockMinutes} minutes; reason=${error.message}`,
  );
}

function parseIsoTime(value: string | null) {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
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
      isNewerThanLastSync(summary.update_time || null, existing);

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

function formatScanProgress(progress: ConversationScanProgress) {
  const total = progress.total === null ? "unknown" : String(progress.total);
  const selected =
    progress.targetCount === null
      ? String(progress.selectedCount)
      : formatProgress(progress.selectedCount, progress.targetCount);
  const stop = progress.stopReason ? ` stop=${progress.stopReason}` : "";
  return (
    `[scan] page=${progress.scannedPages} offset=${progress.offset}` +
    ` fetched=${progress.pageItems} progress=${selected}` +
    ` total=${total}${stop}`
  );
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
  renderUnknownPartsAsJson?: boolean;
  dumpRawConversationJson?: boolean;
  batchLimit: number;
  startDelayMs: number;
}) {
  const filesystem = await readExistingRecords(params.workspaceDir);
  const usedMarkdownPaths = new Set<string>();

  const allPending = Object.entries(params.index.conversations)
    .filter(([, record]) => record.status === "pending")
    .sort(([, left], [, right]) =>
      compareTimestampDesc(
        left.summary.update_time || null,
        right.summary.update_time || null,
      ),
    );
  const pending = selectExportBatch(allPending, params.batchLimit);

  console.log(
    `[export] pending=${allPending.length} batch=${pending.length}/${allPending.length} limit=${formatExportBatchLimit(params.batchLimit)} startDelayMs=${params.startDelayMs}`,
  );

  let previousExportStartedAt: number | null = null;

  for (const [index, [chatId, record]] of pending.entries()) {
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
      console.log(
        `[skip] progress=${formatProgress(index + 1, pending.length)} ${record.summary.title} missing from workspace`,
      );
      continue;
    }

    const chatHref = `https://chatgpt.com/c/${chatId}`;
    await waitBeforeExportStart(
      params.startDelayMs,
      record.summary.title,
      index,
      previousExportStartedAt,
      pending.length,
    );
    previousExportStartedAt = Date.now();
    const startedAt = toIsoNow();
    console.log(
      `[export] progress=${formatProgress(index + 1, pending.length)} ${record.summary.title}`,
    );

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
      renderUnknownPartsAsJson: params.renderUnknownPartsAsJson,
      dumpRawConversationJson: params.dumpRawConversationJson,
    });
    const syncedAt = maxTimestampIso(toIsoNow(), record.summary.update_time);

    upsertConversationIndex(
      params.index,
      chatId,
      buildConversationIndexRecord({
        summary: {
          ...record.summary,
          title: exportResult.title,
        },
        updatedAt: syncedAt,
        status: "exported",
      }),
    );
    await saveChatgptIndex(params.indexPath, params.index);

    console.log(
      `[done] progress=${formatProgress(index + 1, pending.length)} ${exportResult.title} turns=${exportResult.turns} assets=${exportResult.assets}`,
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

  console.log("[export] complete");
}

function selectExportBatch<T>(items: T[], batchLimit: number) {
  if (batchLimit < 0) {
    return items;
  }
  return items.slice(0, batchLimit);
}

function formatExportBatchLimit(batchLimit: number) {
  return batchLimit < 0 ? "unlimited" : String(batchLimit);
}

function formatProgress(current: number, total: number) {
  if (total <= 0) {
    return `${current}/${total} [----------]`;
  }
  const width = 10;
  const filled = Math.min(width, Math.floor((current / total) * width));
  return `${current}/${total} [${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

async function waitBeforeExportStart(
  delayMs: number,
  title: string,
  exportIndex: number,
  previousExportStartedAt: number | null,
  batchCount: number,
) {
  if (exportIndex === 0 || delayMs <= 0 || previousExportStartedAt === null) {
    return;
  }
  const elapsedMs = Date.now() - previousExportStartedAt;
  const remainingDelayMs = delayMs - elapsedMs;
  if (remainingDelayMs <= 0) {
    return;
  }
  console.log(
    `[wait] ${remainingDelayMs}ms before export progress=${formatProgress(exportIndex + 1, batchCount)} ${title}`,
  );
  await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));
}

function isNewerTimestamp(current: string | null, previous: string | null) {
  const currentTime = parseTimestamp(current);
  if (currentTime === null) {
    return false;
  }
  const previousTime = parseTimestamp(previous);
  if (previousTime === null) {
    return true;
  }
  return currentTime > previousTime;
}

function parseTimestamp(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const time =
    typeof value === "number" ? value * 1000 : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function maxTimestampIso(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftTime = parseTimestamp(left);
  const rightTime = parseTimestamp(right);
  if (leftTime === null && rightTime === null) {
    return toIsoNow();
  }
  return new Date(Math.max(leftTime ?? 0, rightTime ?? 0)).toISOString();
}

function isNewerThanLastSync(
  summaryUpdatedAt: string | null,
  record: ChatgptIndexRecord,
) {
  return isNewerTimestamp(
    summaryUpdatedAt,
    record.updated_at || record.summary.update_time || null,
  );
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
