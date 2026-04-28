import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BackendRequestError } from "./errors";
import {
  buildConversationMarkdown,
  normalizeText,
  removeAssetArtifacts,
  renderConversationMarkdownFromApi,
  resolveAssetWriteTarget,
  safeFallbackSlug,
  saveCapturedAssets,
  toIsoNow,
} from "./markdown";
import type {
  ApiConversation,
  AssetStrategy,
  BrowserClient,
  CapturedResponse,
  ConversationSummary,
} from "./types";

export type ConversationExportInput = {
  page: BrowserClient;
  chatId: string;
  chatHref: string;
  workspaceDir: string;
  inboxDir: string;
  assetStrategy: AssetStrategy;
  assetSubdir: string;
  fixedAssetDir: string;
  backendHeaders: Record<string, string>;
  existingRecord?: { filePath: string; frontmatter: Record<string, string> };
  usedMarkdownPaths: Set<string>;
  existingMarkdownPaths: Set<string>;
  titleHint?: string;
  exportStartedAt?: string;
  renderUnknownPartsAsJson?: boolean;
  dumpRawConversationJson?: boolean;
};

export type ConversationExportOutput = {
  title: string;
  href: string;
  filePath: string;
  turns: number;
  assets: number;
  summary: ConversationSummary;
  updatedAt: string;
};

export async function exportConversationFromBackendApi(
  input: ConversationExportInput,
): Promise<ConversationExportOutput> {
  const exportStartedAt = input.exportStartedAt || toIsoNow();
  const rawConversationJson = await fetchConversationJsonFromBrowser(
    input.page,
    input.chatId,
    input.backendHeaders,
  );

  return writeConversationExport({
    input,
    rawConversationJson,
    assetResponses: new Map(),
    exportStartedAt,
  });
}

async function writeConversationExport(params: {
  input: ConversationExportInput;
  rawConversationJson: string;
  assetResponses: Map<string, CapturedResponse>;
  exportStartedAt: string;
}): Promise<ConversationExportOutput> {
  const { input, rawConversationJson, assetResponses, exportStartedAt } =
    params;
  const conversation = JSON.parse(rawConversationJson) as ApiConversation;
  const rendered = renderConversationMarkdownFromApi(conversation, {
    renderUnknownPartsAsJson: input.renderUnknownPartsAsJson,
  });
  const title = normalizeText(
    rendered.title || input.titleHint || input.chatId,
  );
  const slug = safeFallbackSlug(title);
  const targetDir = input.existingRecord
    ? path.dirname(input.existingRecord.filePath)
    : input.inboxDir;

  let fileName = `${slug}.md`;
  let suffix = 2;
  let markdownPath = path.join(targetDir, fileName);
  while (
    input.usedMarkdownPaths.has(path.resolve(markdownPath)) ||
    (input.existingMarkdownPaths.has(path.resolve(markdownPath)) &&
      path.resolve(input.existingRecord?.filePath || "") !==
        path.resolve(markdownPath))
  ) {
    fileName = `${slug}-${suffix}.md`;
    markdownPath = path.join(targetDir, fileName);
    suffix += 1;
  }
  input.usedMarkdownPaths.add(path.resolve(markdownPath));
  input.existingMarkdownPaths.add(path.resolve(markdownPath));

  const assetTarget = resolveAssetWriteTarget({
    strategy: input.assetStrategy,
    workspaceDir: input.workspaceDir,
    markdownPath,
    assetSubdir: input.assetSubdir,
    fixedAssetDir: input.fixedAssetDir,
  });
  await removeAssetArtifacts(assetTarget);

  const { tokenToPath, tokenToFailure } = await saveCapturedAssets(
    rendered.assetIds,
    assetResponses,
    assetTarget,
    async (fileId) => downloadFileById(fileId, input.backendHeaders),
  );
  if (tokenToPath.size === 0) {
    await removeAssetArtifacts(assetTarget);
  }

  const messageBlocks = rendered.blocks
    .map((block) => {
      const markdown = applyAssetReplacements(
        block.markdown,
        tokenToPath,
        tokenToFailure,
      );
      return `## ${block.role}\n\n${markdown}`;
    })
    .join("\n\n");

  const nextContent = buildConversationMarkdown({
    title,
    conversationId: input.chatId,
    href: input.chatHref,
    updatedAt: exportStartedAt,
    messageBlocks,
  });

  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, nextContent, "utf8");
  await syncRawConversationJsonArtifact({
    markdownPath,
    rawConversationJson,
    enabled: Boolean(input.dumpRawConversationJson),
  });

  if (
    input.existingRecord?.filePath &&
    path.resolve(input.existingRecord.filePath) !== path.resolve(markdownPath)
  ) {
    await rm(input.existingRecord.filePath, { force: true });
    await removeRawConversationJsonArtifact(input.existingRecord.filePath);
    const oldAssetTarget = resolveAssetWriteTarget({
      strategy: input.assetStrategy,
      workspaceDir: input.workspaceDir,
      markdownPath: input.existingRecord.filePath,
      assetSubdir: input.assetSubdir,
      fixedAssetDir: input.fixedAssetDir,
    });
    await removeAssetArtifacts(oldAssetTarget);
  }

  return {
    title,
    href: input.chatHref,
    filePath: markdownPath,
    turns: rendered.blocks.length,
    assets: rendered.assetIds.length,
    summary: {
      id: input.chatId,
      title,
      create_time: undefined,
      update_time: undefined,
    },
    updatedAt: exportStartedAt,
  };
}

async function fetchConversationJsonFromBrowser(
  page: BrowserClient,
  chatId: string,
  headers: Record<string, string>,
) {
  const payload = (await page.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `(${function browserFetchConversation(
      chatId: string,
      headers: Record<string, string>,
    ) {
      return (async () => {
        const response = await fetch(
          "/backend-api/conversation/" + encodeURIComponent(chatId),
          {
            credentials: "include",
            headers,
          },
        );
        return {
          ok: response.ok,
          status: response.status,
          text: await response.text(),
        };
      })();
    }.toString()})(${JSON.stringify(chatId)}, ${JSON.stringify(
      normalizeConversationFetchHeaders(headers, chatId),
    )})`,
  })) as {
    result?: {
      value?: {
        ok?: boolean;
        status?: number;
        text?: string;
      };
    };
  };

  const value = payload.result?.value;
  if (!value || !value.ok) {
    throw new BackendRequestError(
      `Could not fetch conversation payload for ${chatId} status=${value?.status ?? "unknown"}`,
      value?.status ?? null,
    );
  }
  if (!value.text) {
    throw new BackendRequestError(
      `Could not fetch conversation payload for ${chatId}: empty response`,
      value.status ?? null,
    );
  }

  return value.text;
}

async function syncRawConversationJsonArtifact(params: {
  markdownPath: string;
  rawConversationJson: string;
  enabled: boolean;
}) {
  const filePath = rawConversationJsonPath(params.markdownPath);
  if (!params.enabled) {
    await rm(filePath, { force: true });
    return;
  }

  await writeFile(
    filePath,
    ensureTrailingNewline(params.rawConversationJson),
    "utf8",
  );
}

async function removeRawConversationJsonArtifact(markdownPath: string) {
  await rm(rawConversationJsonPath(markdownPath), { force: true });
}

function rawConversationJsonPath(markdownPath: string) {
  return markdownPath.replace(/\.md$/i, ".json");
}

function ensureTrailingNewline(value: string) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function applyAssetReplacements(
  markdown: string,
  tokenToPath: Map<string, string>,
  tokenToFailure: Map<string, string>,
) {
  let next = markdown;
  for (const [token, relPath] of tokenToPath.entries()) {
    next = next.replaceAll(token, relPath);
  }
  for (const [token, failureText] of tokenToFailure.entries()) {
    next = replaceFailedAssetMarkdown(next, token, failureText);
  }
  return next;
}

function replaceFailedAssetMarkdown(
  markdown: string,
  token: string,
  failureText: string,
) {
  const escapedToken = escapeRegExp(token);
  return markdown
    .replace(
      new RegExp(`!\\[([^\\]\\n]*)\\]\\(${escapedToken}\\)`, "g"),
      (_match, alt: string) => `${alt || "image"} ${failureText}`,
    )
    .replace(
      new RegExp(`\\[([^\\]\\n]+)\\]\\(${escapedToken}\\)`, "g"),
      (_match, label: string) => `${label} ${failureText}`,
    )
    .replaceAll(token, failureText);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function downloadFileById(
  fileId: string,
  headers: Record<string, string>,
): Promise<CapturedResponse | undefined> {
  const requestHeaders = normalizeDownloadHeaders(headers, fileId);
  const downloadResponse = await fetch(
    `https://chatgpt.com/backend-api/files/download/${fileId}`,
    {
      headers: requestHeaders,
    },
  );
  if (!downloadResponse.ok) {
    throw new BackendRequestError(
      `Could not fetch file download info for ${fileId} status=${downloadResponse.status}`,
      downloadResponse.status,
    );
  }
  const downloadInfo = (await downloadResponse.json()) as {
    download_url?: string;
  };
  if (!downloadInfo.download_url) {
    return undefined;
  }

  const response = await fetch(downloadInfo.download_url, {
    headers: requestHeaders,
  });
  if (!response.ok) {
    throw new BackendRequestError(
      `Could not download file ${fileId} status=${response.status}`,
      response.status,
    );
  }
  const contentType = response.headers.get("content-type") || "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return {
    url: downloadInfo.download_url,
    mimeType: contentType,
    body: Buffer.from(binary, "binary").toString("base64"),
    base64Encoded: true,
  };
}

function normalizeDownloadHeaders(
  headers: Record<string, string>,
  fileId: string,
): Record<string, string> {
  const keys = [
    "authorization",
    "cookie",
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
    const value =
      headers[key] || headers[key.toLowerCase()] || headers[key.toUpperCase()];
    if (value) {
      out[key] = value;
    }
  }
  out["x-openai-target-path"] = `/backend-api/files/download/${fileId}`;
  out["x-openai-target-route"] = "/backend-api/files/download/{file_id}";
  return out;
}

function normalizeConversationFetchHeaders(
  headers: Record<string, string>,
  chatId: string,
): Record<string, string> {
  return omitEmptyHeaders({
    authorization: getHeader(headers, "authorization"),
    "oai-client-build-number": getHeader(headers, "oai-client-build-number"),
    "oai-client-version": getHeader(headers, "oai-client-version"),
    "oai-device-id": getHeader(headers, "oai-device-id"),
    "oai-language": getHeader(headers, "oai-language"),
    "oai-session-id": getHeader(headers, "oai-session-id"),
    "x-openai-target-path": `/backend-api/conversation/${chatId}`,
    "x-openai-target-route": "/backend-api/conversation/{conversation_id}",
    referer: "https://chatgpt.com/",
  });
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

function omitEmptyHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== ""),
  );
}
