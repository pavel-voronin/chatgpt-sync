import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureNavigationResponses, connect, ensureSingleChatgptTab } from "./cdp";
import { resolveConfig } from "./config";
import {
  buildConversationIndexRecord,
  indexFilePath,
  loadChatgptIndex,
  saveChatgptIndex,
  upsertConversationIndex,
} from "./index-store";
import { planConversationSummaries } from "./list-scan";
import { exportConversation } from "./conversation-export";
import {
  buildConversationMarkdown,
  escapeFrontmatter,
  normalizeText,
  readExistingRecords,
  safeFallbackSlug,
  renderConversationMarkdownFromApi,
  removeExistingArtifacts,
  saveCapturedAssets,
  stripUpdatedAt,
  toIsoNow,
} from "./markdown";
import type { ApiConversation, CapturedResponse } from "./types";

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
  const existingRecords = await readExistingRecords(exportDir);
  const indexPath = indexFilePath(exportDir);
  const index = await loadChatgptIndex(indexPath, exportDir, listLimit);
  const runStartedAt = toIsoNow();

  const version = (await fetch(`${cdpHttp}/json/version`).then((res) => res.json())) as {
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
      headers?.["x-openai-target-path"] || headers?.["X-OpenAI-Target-Path"] || "",
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
      throw new Error("Could not capture backend API headers from the active browser tab");
    }

    if (conversationId) {
      const exportResult = await exportConversation({
        page,
        chatId: conversationId,
        chatHref: `https://chatgpt.com/c/${conversationId}`,
        exportDir,
        backendHeaders,
        existingRecord: existingRecords.get(conversationId),
        usedFileNames: new Set<string>(),
        existingFileNames: new Set(
          (await readdir(exportDir).catch(() => [])).filter((name) => name.endsWith(".md")),
        ),
      });

      upsertConversationIndex(
        index,
        conversationId,
        buildConversationIndexRecord({
          summary: exportResult.summary,
          sourceUrl: exportResult.href,
          filePath: exportResult.filePath,
          assetDir: exportResult.assetDir,
          exportedAt: exportResult.exportedAt,
          updatedAt: exportResult.updatedAt,
          assetCount: exportResult.images,
          status: "exported",
          lastSeenAt: runStartedAt,
          lastExportedAt: toIsoNow(),
        }),
      );
      await saveChatgptIndex(indexPath, index);

      console.log(
        JSON.stringify(
          [
            {
              title: exportResult.title,
              filePath: exportResult.filePath,
              href: exportResult.href,
              turns: exportResult.turns,
              images: exportResult.images,
            },
          ],
          null,
          2,
        ),
      );
      return;
    }

    index.sync.last_run_started_at = runStartedAt;
    index.sync.last_run_mode = syncMode;
    index.sync.last_run_effective_mode = syncMode;
    index.sync.last_run_page_limit = listLimit;
    index.sync.last_run_limit = syncCount;
    index.sync.last_run_days = syncDays;
    index.sync.last_run_count = syncCount;
    index.sync.last_run_overlap_minutes = syncOverlapMinutes;
    await saveChatgptIndex(indexPath, index);

    const scanPlan = await planConversationSummaries(page, {
      mode: syncMode,
      pageLimit: listLimit,
      countLimit: syncCount,
      daysLimit: syncDays,
      overlapMinutes: syncOverlapMinutes,
      lastSyncAt: index.sync.last_sync_at,
      bootstrapMode,
      bootstrapCount,
      bootstrapDays,
      requestHeaders: backendHeaders,
    });
    index.sync.last_run_effective_mode = scanPlan.effectiveMode;
    index.sync.last_run_limit = scanPlan.countLimit;
    index.sync.last_run_days = scanPlan.daysLimit;
    index.sync.last_run_count = scanPlan.countLimit;
    index.sync.last_run_selected_count = scanPlan.selectedCount;
    index.sync.last_run_newest_update_time = scanPlan.newestUpdateTime;
    index.sync.last_run_oldest_update_time = scanPlan.oldestUpdateTime;
    await saveChatgptIndex(indexPath, index);

    if (scanPlan.items.length === 0) {
      throw new Error("Could not extract conversations from API");
    }

    const exported: Array<{
      title: string;
      filePath: string;
      href: string;
      turns: number;
      images: number;
    }> = [];
    const usedFileNames = new Set<string>();
    const existingFileNames = new Set(
      (await readdir(exportDir).catch(() => [])).filter((name) => name.endsWith(".md")),
    );

    for (const chat of scanPlan.items) {
    const chatHref = `https://chatgpt.com/c/${chat.id}`;
    console.log(`[export] ${chat.title}`);
    const convoResponses = await captureNavigationResponses(
      page,
      chatHref,
      (responseUrl) => responseUrl.includes("/backend-api/"),
      (responses) => {
        const convoEntry = [...responses.entries()].find(([responseUrl]) => {
          try {
            const parsed = new URL(responseUrl);
            return parsed.pathname === `/backend-api/conversation/${chat.id}`;
          } catch {
            return false;
          }
        });
        if (!convoEntry) {
          return false;
        }
        try {
          const parsed = JSON.parse(responseBodyToText(convoEntry[1])) as ApiConversation;
          return Boolean(parsed.mapping && Object.keys(parsed.mapping).length > 0);
        } catch {
          return false;
        }
      },
    );
    const convoEntry = [...convoResponses.entries()].find(([responseUrl]) => {
      try {
        const parsed = new URL(responseUrl);
        return parsed.pathname === `/backend-api/conversation/${chat.id}`;
      } catch {
        return false;
      }
    });
    if (!convoEntry) {
      throw new Error(`Could not capture conversation payload for ${chat.id}`);
    }

    const conversation = JSON.parse(responseBodyToText(convoEntry[1])) as ApiConversation;
    const rendered = renderConversationMarkdownFromApi(conversation);
    const title = normalizeText(rendered.title || chat.title);
    const slug = safeFallbackSlug(title);

    let fileName = `${slug}.md`;
    let suffix = 2;
    while (
      usedFileNames.has(fileName) ||
      (existingFileNames.has(fileName) &&
        path.basename(existingRecords.get(chat.id)?.filePath || "") !== fileName)
    ) {
      fileName = `${slug}-${suffix}.md`;
      suffix += 1;
    }
    usedFileNames.add(fileName);
    existingFileNames.add(fileName);

    const markdownPath = path.join(exportDir, fileName);
    const assetDir = path.join(exportDir, "assets", path.basename(fileName, ".md"));

    const assetResponses = new Map<string, CapturedResponse>();
    for (const [responseUrl, response] of convoResponses.entries()) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(responseUrl);
      } catch {
        continue;
      }
      if (parsedUrl.pathname !== "/backend-api/estuary/content") {
        continue;
      }
      try {
        const fileId = parsedUrl.searchParams.get("id");
        if (fileId) {
          assetResponses.set(fileId, response as CapturedResponse);
        }
      } catch {
        // Ignore malformed asset URLs.
      }
    }

    const tokenToPath = await saveCapturedAssets(
      rendered.assetIds,
      assetResponses,
      assetDir,
      async (fileId) => {
        if (!backendHeaders) {
          return undefined;
        }
        return downloadFileById(page, fileId, backendHeaders);
      },
    );
    if (tokenToPath.size === 0) {
      await rm(assetDir, { recursive: true, force: true });
    }
    const messageBlocks = rendered.blocks
      .map((block) => {
        let markdown = block.markdown;
        for (const [token, relPath] of tokenToPath.entries()) {
          markdown = markdown.replaceAll(token, relPath);
        }
        return `## ${block.role}\n\n${markdown}`;
      })
      .join("\n\n");

    const existing = existingRecords.get(chat.id);
    const exportedAt = existing?.frontmatter.exported_at || toIsoNow();
    const existingUpdatedAt = existing?.frontmatter.updated_at || exportedAt;
    const nextContent = buildConversationMarkdown({
      title,
      conversationId: chat.id,
      href: chatHref,
      exportedAt,
      updatedAt: existingUpdatedAt,
      messageBlocks,
    });

    let finalContent = nextContent;
    const existingContent = existing?.filePath
      ? await readFile(existing.filePath, "utf8").catch(() => "")
      : "";
    const existingSamePath =
      existing?.filePath && path.resolve(existing.filePath) === path.resolve(markdownPath);
    const contentChanged =
      !existingContent ||
      stripUpdatedAt(existingContent) !== stripUpdatedAt(nextContent);
    const contentUpdatedAt = contentChanged ? toIsoNow() : existingUpdatedAt;

    if (existingSamePath && !contentChanged) {
      finalContent = existingContent;
    } else if (contentChanged) {
      finalContent = nextContent.replace(
        /^updated_at: .*$/m,
        `updated_at: ${escapeFrontmatter(contentUpdatedAt)}`,
      );
    }

    if (!existingSamePath || contentChanged) {
      await writeFile(markdownPath, finalContent, "utf8");
    }

    if (existing?.filePath && path.resolve(existing.filePath) !== path.resolve(markdownPath)) {
      await removeExistingArtifacts(existing.filePath, exportDir);
    }

    upsertConversationIndex(
      index,
      chat.id,
      buildConversationIndexRecord({
        summary: chat,
        sourceUrl: chatHref,
        filePath: markdownPath,
        assetDir,
        exportedAt,
        updatedAt: contentUpdatedAt,
        assetCount: rendered.assetIds.length,
        status: "exported",
        lastSeenAt: runStartedAt,
        lastExportedAt: toIsoNow(),
      }),
    );
    await saveChatgptIndex(indexPath, index);

    exported.push({
      title,
      filePath: markdownPath,
      href: chatHref,
      turns: rendered.blocks.length,
      images: rendered.assetIds.length,
    });
    console.log(`[done] ${title} turns=${rendered.blocks.length} assets=${rendered.assetIds.length}`);
    }

    index.sync.last_run_completed_at = toIsoNow();
    index.sync.last_sync_at = index.sync.last_run_completed_at;
    index.sync.last_run_exported_count = exported.length;
    await saveChatgptIndex(indexPath, index);
    console.log(JSON.stringify(exported, null, 2));
  } finally {
    offHeaders();
    page.close();
  }
}

function responseBodyToText(response: CapturedResponse): string {
  return response.base64Encoded
    ? Buffer.from(response.body, "base64").toString("utf8")
    : response.body;
}

async function downloadFileById(
  page: Awaited<ReturnType<typeof connect>>,
  fileId: string,
  headers: Record<string, string>,
): Promise<CapturedResponse | undefined> {
  const payload = (await page.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `(${function browserDownloadFile(fileId: string, headers: Record<string, string>) {
      return (async () => {
        const downloadResponse = await fetch(
          "/backend-api/files/download/" + fileId,
          {
            credentials: "include",
            headers,
          },
        );
        if (!downloadResponse.ok) {
          return {
            ok: false,
            status: downloadResponse.status,
          };
        }
        const downloadInfo = (await downloadResponse.json()) as {
          download_url?: string;
        };
        if (!downloadInfo.download_url) {
          return {
            ok: false,
            status: "missing-download-url",
          };
        }
        const response = await fetch(downloadInfo.download_url, {
          credentials: "include",
        });
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
          };
        }
        const contentType = response.headers.get("content-type") || "";
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return {
          ok: true,
          url: downloadInfo.download_url,
          mimeType: contentType,
          body: btoa(binary),
          base64Encoded: true,
        };
      })();
    }.toString()})(${JSON.stringify(fileId)}, ${JSON.stringify(normalizeDownloadHeaders(headers, fileId))})`,
  })) as
    | { result?: { value?: { ok?: true; url?: string; mimeType?: string; body?: string; base64Encoded?: boolean } | { ok?: false; status?: number | string } } }
    | undefined;

  const value = payload?.result?.value;
  if (!value || !("ok" in value) || !value.ok) {
    return undefined;
  }
  return {
    url: value.url || "",
    mimeType: value.mimeType || "",
    body: value.body || "",
    base64Encoded: Boolean(value.base64Encoded),
  };
}

function normalizeDownloadHeaders(
  headers: Record<string, string>,
  fileId: string,
): Record<string, string> {
  const keys = [
    "authorization",
    "oai-client-build-number",
    "oai-client-version",
    "oai-device-id",
    "oai-language",
    "oai-session-id",
    "x-openai-target-path",
    "x-openai-target-route",
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = headers[key] || headers[key.toLowerCase()] || headers[key.toUpperCase()];
    if (value) {
      out[key] = value;
    }
  }
  out["x-openai-target-path"] = `/backend-api/files/download/${fileId}`;
  out["x-openai-target-route"] = "/backend-api/files/download/{file_id}";
  return out;
}
