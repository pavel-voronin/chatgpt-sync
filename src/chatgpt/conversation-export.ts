import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureNavigationResponses } from "./cdp";
import {
  buildConversationMarkdown,
  normalizeText,
  renderConversationMarkdownFromApi,
  safeFallbackSlug,
  saveCapturedAssets,
  toIsoNow,
} from "./markdown";
import type {
  ApiConversation,
  BrowserClient,
  CapturedResponse,
  ConversationSummary,
} from "./types";

export type ConversationExportInput = {
  page: BrowserClient;
  chatId: string;
  chatHref: string;
  exportDir: string;
  backendHeaders: Record<string, string>;
  existingRecord?: { filePath: string; frontmatter: Record<string, string> };
  usedFileNames: Set<string>;
  existingFileNames: Set<string>;
  titleHint?: string;
  exportStartedAt?: string;
};

export type ConversationExportOutput = {
  title: string;
  href: string;
  filePath: string;
  assetDir: string;
  turns: number;
  assets: number;
  summary: ConversationSummary;
  exportedAt: string;
  updatedAt: string;
};

export async function exportConversation(
  input: ConversationExportInput,
): Promise<ConversationExportOutput> {
  const exportStartedAt = input.exportStartedAt || toIsoNow();
  const convoResponses = await captureNavigationResponses(
    input.page,
    input.chatHref,
    (responseUrl) => responseUrl.includes("/backend-api/"),
    (responses) => {
      const convoEntry = [...responses.entries()].find(([responseUrl]) => {
        try {
          return (
            new URL(responseUrl).pathname ===
            `/backend-api/conversation/${input.chatId}`
          );
        } catch {
          return false;
        }
      });
      if (!convoEntry) {
        return false;
      }
      try {
        const parsed = JSON.parse(
          responseBodyToText(convoEntry[1]),
        ) as ApiConversation;
        return Boolean(
          parsed.mapping && Object.keys(parsed.mapping).length > 0,
        );
      } catch {
        return false;
      }
    },
  );

  const convoEntry = [...convoResponses.entries()].find(([responseUrl]) => {
    try {
      return (
        new URL(responseUrl).pathname ===
        `/backend-api/conversation/${input.chatId}`
      );
    } catch {
      return false;
    }
  });
  if (!convoEntry) {
    throw new Error(
      `Could not capture conversation payload for ${input.chatId}`,
    );
  }

  const conversation = JSON.parse(
    responseBodyToText(convoEntry[1]),
  ) as ApiConversation;
  const rendered = renderConversationMarkdownFromApi(conversation);
  const title = normalizeText(
    rendered.title || input.titleHint || input.chatId,
  );
  const slug = safeFallbackSlug(title);

  let fileName = `${slug}.md`;
  let suffix = 2;
  while (
    input.usedFileNames.has(fileName) ||
    (input.existingFileNames.has(fileName) &&
      path.basename(input.existingRecord?.filePath || "") !== fileName)
  ) {
    fileName = `${slug}-${suffix}.md`;
    suffix += 1;
  }
  input.usedFileNames.add(fileName);
  input.existingFileNames.add(fileName);

  const markdownPath = path.join(input.exportDir, fileName);
  const assetDir = path.join(
    input.exportDir,
    "assets",
    path.basename(fileName, ".md"),
  );

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
    const fileId = parsedUrl.searchParams.get("id");
    if (fileId) {
      assetResponses.set(fileId, response as CapturedResponse);
    }
  }

  const tokenToPath = await saveCapturedAssets(
    rendered.assetIds,
    assetResponses,
    assetDir,
    async (fileId) => downloadFileById(fileId, input.backendHeaders),
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

  const exportedAt =
    input.existingRecord?.frontmatter.exported_at || exportStartedAt;
  const nextContent = buildConversationMarkdown({
    title,
    conversationId: input.chatId,
    href: input.chatHref,
    exportedAt,
    updatedAt: exportStartedAt,
    messageBlocks,
  });

  await writeFile(markdownPath, nextContent, "utf8");

  if (
    input.existingRecord?.filePath &&
    path.resolve(input.existingRecord.filePath) !== path.resolve(markdownPath)
  ) {
    await rm(input.existingRecord.filePath, { force: true });
    await rm(
      path.join(
        input.exportDir,
        "assets",
        path.basename(input.existingRecord.filePath, ".md"),
      ),
      {
        recursive: true,
        force: true,
      },
    );
  }

  return {
    title,
    href: input.chatHref,
    filePath: markdownPath,
    assetDir,
    turns: rendered.blocks.length,
    assets: rendered.assetIds.length,
    summary: {
      id: input.chatId,
      title,
      create_time: undefined,
      update_time: undefined,
    },
    exportedAt,
    updatedAt: exportStartedAt,
  };
}

function responseBodyToText(response: CapturedResponse): string {
  return response.base64Encoded
    ? Buffer.from(response.body, "base64").toString("utf8")
    : response.body;
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
    return undefined;
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
    return undefined;
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
