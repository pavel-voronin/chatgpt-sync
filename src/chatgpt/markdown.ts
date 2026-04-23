import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiConversation, CapturedResponse } from "./types";

export function toIsoNow(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

export function safeFallbackSlug(input: string): string {
  const slug = slugify(input);
  return slug.length > 0 ? slug : "chat";
}

export function normalizeText(input: string): string {
  return String(input)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeFrontmatter(value: string): string {
  return JSON.stringify(value);
}

export function parseFrontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function stripUpdatedAt(content: string): string {
  return content.replace(/^updated_at:.*\n?/m, "");
}

export async function readExistingRecords(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  const records = new Map<
    string,
    { filePath: string; frontmatter: Record<string, string> }
  >();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    const content = await readFile(filePath, "utf8");
    const frontmatter = parseFrontmatter(content);
    const conversationId = frontmatter.conversation_id;
    if (conversationId) {
      records.set(conversationId, { filePath, frontmatter });
    }
  }

  return records;
}

export function inferFileExt(contentType: string | null, src: string): string {
  const normalized = contentType?.toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/svg+xml") return ".svg";
  if (normalized === "text/plain") return ".txt";
  if (normalized === "text/markdown") return ".md";
  if (normalized === "application/json") return ".json";
  if (normalized === "application/pdf") return ".pdf";

  try {
    const pathname = new URL(src).pathname;
    const ext = path.extname(pathname);
    if (ext) {
      return ext;
    }
  } catch {
    // Ignore invalid URLs.
  }

  return ".png";
}

export function isHiddenConversationNode(node: {
  message?: {
    author?: { role?: string };
    content?: { content_type?: string };
    metadata?: Record<string, unknown>;
  };
}) {
  const role = node.message?.author?.role || "";
  const contentType = node.message?.content?.content_type || "";
  const metadata = node.message?.metadata || {};
  if (metadata.is_visually_hidden_from_conversation) {
    return true;
  }
  if (["system", "user_editable_context"].includes(role)) {
    return true;
  }
  if (
    ["thoughts", "reasoning_recap", "model_editable_context"].includes(
      contentType,
    )
  ) {
    return true;
  }
  if (contentType === "code") {
    return true;
  }
  return false;
}

export function assetIdFromPointer(pointer: string): string {
  return pointer.replace(/^sediment:\/\//, "");
}

export function renderPartMarkdown(
  part: unknown,
  recordAsset: (fileId: string) => string,
  metadata: Record<string, unknown>,
): string {
  if (typeof part === "string") {
    return normalizeText(part);
  }

  if (!part || typeof part !== "object") {
    return "";
  }

  const typed = part as {
    content_type?: string;
    text?: string;
    asset_pointer?: string;
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };

  if (typed.content_type === "image_asset_pointer" && typed.asset_pointer) {
    const fileId = assetIdFromPointer(typed.asset_pointer);
    const token = recordAsset(fileId);
    const alt =
      (metadata as { image_gen_title?: string })?.image_gen_title ||
      typed.title ||
      "image";
    return `![${String(alt).replace(/]/g, "\\]")}](${token})`;
  }

  if (typed.content_type === "file_asset_pointer" && typed.asset_pointer) {
    const fileId = assetIdFromPointer(typed.asset_pointer);
    const token = recordAsset(fileId);
    const label = typed.file_name || "file";
    return `[${label}](${token})`;
  }

  if (typeof typed.text === "string") {
    return normalizeText(typed.text);
  }

  return "";
}

export function renderConversationMarkdownFromApi(
  conversation: ApiConversation,
) {
  const mapping = conversation?.mapping || {};
  const root =
    mapping["client-created-root"] ||
    Object.values(mapping).find((node: any) => !node.parent);
  const assetIds: string[] = [];
  const assetSeen = new Set<string>();

  const recordAsset = (fileId: string) => {
    if (!fileId || assetSeen.has(fileId)) {
      return `__ASSET_${fileId}__`;
    }
    assetSeen.add(fileId);
    assetIds.push(fileId);
    return `__ASSET_${fileId}__`;
  };

  const blocks: Array<{ role: string; markdown: string }> = [];

  const visit = (node: any) => {
    if (!node) {
      return;
    }

    const message = node.message;
    if (message && !isHiddenConversationNode(node)) {
      const role = message.author?.role || "assistant";
      const content = message.content || {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const metadata = message.metadata || {};
      let markdown = parts
        .map((part: unknown) => renderPartMarkdown(part, recordAsset, metadata))
        .filter(Boolean)
        .join("\n\n");

      const attachments = Array.isArray(metadata.attachments)
        ? metadata.attachments
        : [];
      for (const attachment of attachments as Array<{
        id?: string;
        name?: string;
      }>) {
        if (!attachment?.id) continue;
        const token = `__ASSET_${attachment.id}__`;
        if (!markdown.includes(token)) {
          const label = attachment.name || attachment.id;
          markdown = `${markdown}\n\n[${label}](${token})`.trim();
        }
        recordAsset(attachment.id);
      }

      markdown = markdown.trim();
      if (markdown) {
        const roleLabel =
          role === "user"
            ? "User"
            : role === "assistant"
              ? "Assistant"
              : role === "tool"
                ? "Assistant"
                : role;
        blocks.push({ role: roleLabel, markdown });
      }
    }

    for (const childId of node.children || []) {
      visit(mapping[childId]);
    }
  };

  visit(root);

  return {
    title: conversation?.title || "",
    blocks,
    assetIds,
  };
}

export async function saveCapturedAssets(
  assetIds: string[],
  assetResponses: Map<string, CapturedResponse>,
  assetDir: string,
  downloader?: (fileId: string) => Promise<CapturedResponse | undefined>,
): Promise<Map<string, string>> {
  const tokenToPath = new Map<string, string>();
  let index = 1;
  for (const fileId of assetIds) {
    let response = assetResponses.get(fileId);
    if (!response && downloader) {
      response = await downloader(fileId);
    }
    if (!response) {
      continue;
    }

    const ext = inferFileExt(response.mimeType, response.url);
    const filename = `asset-${String(index).padStart(2, "0")}${ext}`;
    const filePath = path.join(assetDir, filename);
    const bytes = Buffer.from(
      response.body,
      response.base64Encoded ? "base64" : "utf8",
    );
    await mkdir(assetDir, { recursive: true });
    tokenToPath.set(
      `__ASSET_${fileId}__`,
      path.posix.join("assets", path.basename(assetDir), filename),
    );
    index += 1;
    await writeFile(filePath, bytes);
  }

  return tokenToPath;
}

export function buildConversationMarkdown(params: {
  title: string;
  conversationId: string;
  href: string;
  exportedAt: string;
  updatedAt: string;
  messageBlocks: string;
}) {
  const { title, conversationId, href, exportedAt, updatedAt, messageBlocks } =
    params;
  return [
    "---",
    `title: ${escapeFrontmatter(title)}`,
    `conversation_id: ${escapeFrontmatter(conversationId)}`,
    `source_url: ${escapeFrontmatter(href)}`,
    `exported_at: ${escapeFrontmatter(exportedAt)}`,
    `updated_at: ${escapeFrontmatter(updatedAt)}`,
    "---",
    "",
    `# ${title}`,
    "",
    messageBlocks,
    "",
  ].join("\n");
}

export async function removeExistingArtifacts(
  existingFilePath: string,
  exportDir: string,
) {
  await rm(existingFilePath, { force: true });
  const oldAssetDir = path.join(
    exportDir,
    "assets",
    path.basename(existingFilePath, ".md"),
  );
  await rm(oldAssetDir, { recursive: true, force: true });
}
