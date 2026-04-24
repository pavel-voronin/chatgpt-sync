import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiConversation, AssetStrategy, CapturedResponse } from "./types";

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
  const records = new Map<
    string,
    { filePath: string; frontmatter: Record<string, string> }
  >();
  const markdownPaths = new Set<string>();

  await walkMarkdownRecords(dir, records, markdownPaths);

  return {
    records,
    markdownPaths,
  };
}

async function walkMarkdownRecords(
  dir: string,
  records: Map<
    string,
    { filePath: string; frontmatter: Record<string, string> }
  >,
  markdownPaths: Set<string>,
) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdownRecords(filePath, records, markdownPaths);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    markdownPaths.add(path.resolve(filePath));
    const content = await readFile(filePath, "utf8").catch(() => "");
    const frontmatter = parseFrontmatter(content);
    const conversationId = frontmatter.conversation_id;
    if (conversationId && !records.has(conversationId)) {
      records.set(conversationId, {
        filePath: path.resolve(filePath),
        frontmatter,
      });
    }
  }
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
    recipient?: string;
    content?: { content_type?: string };
    metadata?: Record<string, unknown>;
  };
}) {
  const role = node.message?.author?.role || "";
  const recipient = node.message?.recipient || "";
  const contentType = node.message?.content?.content_type || "";
  const metadata = node.message?.metadata || {};
  if (metadata.is_visually_hidden_from_conversation) {
    return true;
  }
  if (recipient === "api_tool.call_tool") {
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
  options: { renderUnknownPartsAsJson?: boolean } = {},
): string {
  if (typeof part === "string") {
    return normalizeText(renderAnnotatedText(part, metadata));
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
    return normalizeText(renderAnnotatedText(typed.text, metadata));
  }

  if (options.renderUnknownPartsAsJson) {
    return renderJsonMarkdown(part);
  }

  return "";
}

type ContentReference = {
  matched_text?: string;
  type?: string;
  alt?: string;
  prompt_text?: string;
  name?: string;
  title?: string | null;
  items?: Array<{
    title?: string | null;
    url?: string | null;
    attribution?: string | null;
    supporting_websites?: Array<{
      title?: string | null;
      url?: string | null;
      attribution?: string | null;
    }> | null;
  }> | null;
  sources?: Array<{
    title?: string | null;
    url?: string | null;
    attribution?: string | null;
  }> | null;
};

function renderAnnotatedText(
  text: string,
  metadata: Record<string, unknown>,
): string {
  let rendered = text;
  const references = Array.isArray(metadata.content_references)
    ? (metadata.content_references as ContentReference[])
    : [];

  const replacements = references
    .map((reference) => ({
      matchedText: reference.matched_text,
      markdown: renderContentReferenceMarkdown(reference),
    }))
    .filter(
      (
        replacement,
      ): replacement is { matchedText: string; markdown: string } =>
        typeof replacement.matchedText === "string" &&
        replacement.matchedText.trim().length > 0 &&
        typeof replacement.markdown === "string",
    )
    .sort((a, b) => b.matchedText.length - a.matchedText.length);

  for (const { matchedText, markdown } of replacements) {
    rendered = rendered.split(matchedText).join(markdown);
  }

  const sourceFootnote = references.find(
    (reference) =>
      reference.type === "sources_footnote" &&
      (!reference.matched_text || reference.matched_text.trim().length === 0),
  );
  const sourceFootnoteMarkdown = sourceFootnote
    ? renderSourcesFootnoteMarkdown(sourceFootnote)
    : "";
  if (sourceFootnoteMarkdown && !rendered.includes(sourceFootnoteMarkdown)) {
    rendered = `${rendered.trimEnd()}\n\n${sourceFootnoteMarkdown}`;
  }

  return stripPrivateUseAnnotations(rendered);
}

function renderContentReferenceMarkdown(
  reference: ContentReference,
): string | null {
  if (reference.type === "entity") {
    return reference.name || reference.alt || reference.prompt_text || "";
  }

  if (reference.type === "nav_list") {
    return renderNavListMarkdown(reference);
  }

  if (reference.type === "sources_footnote") {
    return renderSourcesFootnoteMarkdown(reference);
  }

  if (reference.alt) {
    return reference.alt;
  }

  const links = extractContentReferenceLinks(reference);
  if (links.length === 0) {
    return "";
  }

  return renderInlineLinkList(links);
}

function renderNavListMarkdown(reference: ContentReference): string {
  const links = extractContentReferenceLinks(reference);
  if (links.length === 0) {
    return "";
  }

  const title = extractNavListTitle(reference.matched_text || "");
  const body = links
    .map((link) => `- ${renderMarkdownLink(link.label, link.url)}`)
    .join("\n");
  return title ? `### ${title}\n\n${body}` : body;
}

function renderSourcesFootnoteMarkdown(reference: ContentReference): string {
  const links = extractContentReferenceLinks(reference);
  if (links.length === 0) {
    return "";
  }

  return `## Sources\n\n${links
    .map((link) => `- ${renderMarkdownLink(link.label, link.url)}`)
    .join("\n")}`;
}

function extractContentReferenceLinks(reference: ContentReference) {
  const links: Array<{ label: string; url: string }> = [];

  const addLink = (
    item?: {
      title?: string | null;
      url?: string | null;
      attribution?: string | null;
    } | null,
  ) => {
    const url = item?.url;
    if (!url || links.some((link) => link.url === url)) {
      return;
    }
    links.push({
      label: item.title || item.attribution || readableUrlLabel(url),
      url,
    });
  };

  for (const item of reference.items || []) {
    addLink(item);
    for (const supporting of item.supporting_websites || []) {
      addLink(supporting);
    }
  }

  for (const source of reference.sources || []) {
    addLink(source);
  }

  return links;
}

function renderInlineLinkList(links: Array<{ label: string; url: string }>) {
  return `(${links
    .map((link) => renderMarkdownLink(link.label, link.url))
    .join(", ")})`;
}

function renderMarkdownLink(label: string, url: string): string {
  return `[${escapeMarkdownLinkText(label)}](${url.replace(/\)/g, "%29")})`;
}

function escapeMarkdownLinkText(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function readableUrlLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function extractNavListTitle(matchedText: string): string {
  const match = matchedText.match(/^\uE200navlist\uE202(.+?)\uE202/);
  return match ? match[1].trim() : "";
}

function stripPrivateUseAnnotations(text: string): string {
  return text
    .replace(
      /\uE200entity\uE202(\[[^\uE000-\uF8FF]*\])\uE201/g,
      (_, rawJson: string) => {
        try {
          const parsed = JSON.parse(rawJson) as unknown;
          return Array.isArray(parsed) && typeof parsed[1] === "string"
            ? parsed[1]
            : "";
        } catch {
          return "";
        }
      },
    )
    .replace(/\uE200cite(?:\uE202[^\uE000-\uF8FF]+)+\uE201/g, "")
    .replace(/\uE200navlist(?:\uE202[^\uE000-\uF8FF]+)+\uE201/g, "")
    .replace(/[\uE200-\uE202]/g, "");
}

export function renderConversationMarkdownFromApi(
  conversation: ApiConversation,
  options: { renderUnknownPartsAsJson?: boolean } = {},
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
    const deepResearchMarkdown = message
      ? renderDeepResearchMarkdown(message, recordAsset, options)
      : "";
    if (deepResearchMarkdown) {
      blocks.push({ role: "Assistant", markdown: deepResearchMarkdown });
    } else if (message && !isHiddenConversationNode(node)) {
      const role = message.author?.role || "assistant";
      const content = message.content || {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const metadata = message.metadata || {};
      let markdown = parts
        .map((part: unknown) =>
          renderPartMarkdown(part, recordAsset, metadata, options),
        )
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

function renderDeepResearchMarkdown(
  message: any,
  recordAsset: (fileId: string) => string,
  options: { renderUnknownPartsAsJson?: boolean },
): string {
  const sdk = message?.metadata?.chatgpt_sdk;
  if (!sdk || typeof sdk !== "object") {
    return "";
  }

  const isDeepResearch =
    sdk.html_asset_pointer === "internal://deep-research" ||
    String(sdk.resolved_pineapple_uri || "").includes(
      "connector_openai_deep_research",
    );
  if (!isDeepResearch || typeof sdk.widget_state !== "string") {
    return "";
  }

  let widgetState: any;
  try {
    widgetState = JSON.parse(sdk.widget_state);
  } catch {
    return "";
  }

  const reportMessage = widgetState?.report_message;
  if (!reportMessage || isHiddenConversationNode({ message: reportMessage })) {
    return "";
  }

  const content = reportMessage.content || {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const metadata = reportMessage.metadata || {};
  return parts
    .map((part: unknown) =>
      renderPartMarkdown(part, recordAsset, metadata, options),
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export type AssetWriteTarget = {
  directory: string;
  relativeDir: string;
  cleanupPrefix: string | null;
  cleanupMode: "directory" | "prefix";
};

export function resolveAssetWriteTarget(params: {
  strategy: AssetStrategy;
  workspaceDir: string;
  markdownPath: string;
  assetSubdir: string;
  fixedAssetDir: string;
}) {
  const markdownDir = path.dirname(params.markdownPath);
  const baseName = path.basename(params.markdownPath, ".md");

  if (params.strategy === "same-folder") {
    return {
      directory: markdownDir,
      relativeDir: ".",
      cleanupPrefix: `${baseName}-asset-`,
      cleanupMode: "prefix",
    } satisfies AssetWriteTarget;
  }

  if (params.strategy === "vault-root") {
    return {
      directory: params.workspaceDir,
      relativeDir: toPosixPath(path.relative(markdownDir, params.workspaceDir)),
      cleanupPrefix: `${baseName}-asset-`,
      cleanupMode: "prefix",
    } satisfies AssetWriteTarget;
  }

  if (params.strategy === "fixed-folder") {
    return {
      directory: params.fixedAssetDir,
      relativeDir: toPosixPath(
        path.relative(markdownDir, params.fixedAssetDir),
      ),
      cleanupPrefix: `${baseName}-asset-`,
      cleanupMode: "prefix",
    } satisfies AssetWriteTarget;
  }

  const directory = path.join(markdownDir, params.assetSubdir, baseName);
  return {
    directory,
    relativeDir: toPosixPath(path.relative(markdownDir, directory)),
    cleanupPrefix: null,
    cleanupMode: "directory",
  } satisfies AssetWriteTarget;
}

export async function removeAssetArtifacts(target: AssetWriteTarget) {
  if (target.cleanupMode === "directory") {
    await rm(target.directory, { recursive: true, force: true });
    return;
  }

  const entries = await readdir(target.directory, {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !target.cleanupPrefix) {
      continue;
    }
    if (entry.name.startsWith(target.cleanupPrefix)) {
      await rm(path.join(target.directory, entry.name), { force: true });
    }
  }
}

export async function saveCapturedAssets(
  assetIds: string[],
  assetResponses: Map<string, CapturedResponse>,
  target: AssetWriteTarget,
  downloader?: (fileId: string) => Promise<CapturedResponse | undefined>,
): Promise<Map<string, string>> {
  const tokenToPath = new Map<string, string>();
  const usedNames = new Set<string>();
  const existingNames = new Set(
    (await readdir(target.directory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
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
    const baseName =
      target.cleanupMode === "directory"
        ? `asset-${String(index).padStart(2, "0")}`
        : `${target.cleanupPrefix}${String(index).padStart(2, "0")}`;
    let filename = `${baseName}${ext}`;
    let suffix = 2;
    while (usedNames.has(filename) || existingNames.has(filename)) {
      filename = `${baseName}-${suffix}${ext}`;
      suffix += 1;
    }
    const filePath = path.join(target.directory, filename);
    const bytes = Buffer.from(
      response.body,
      response.base64Encoded ? "base64" : "utf8",
    );
    await mkdir(target.directory, { recursive: true });
    tokenToPath.set(
      `__ASSET_${fileId}__`,
      buildRelativeAssetPath(target.relativeDir, filename),
    );
    usedNames.add(filename);
    existingNames.add(filename);
    index += 1;
    await writeFile(filePath, bytes);
  }

  return tokenToPath;
}

export function buildConversationMarkdown(params: {
  title: string;
  conversationId: string;
  href: string;
  updatedAt: string;
  messageBlocks: string;
}) {
  const { title, conversationId, href, updatedAt, messageBlocks } = params;
  return [
    "---",
    `title: ${escapeFrontmatter(title)}`,
    `conversation_id: ${escapeFrontmatter(conversationId)}`,
    `source_url: ${escapeFrontmatter(href)}`,
    `updated_at: ${escapeFrontmatter(updatedAt)}`,
    "---",
    "",
    `# ${title}`,
    "",
    messageBlocks,
    "",
  ].join("\n");
}

function buildRelativeAssetPath(relativeDir: string, filename: string) {
  if (!relativeDir || relativeDir === ".") {
    return filename;
  }
  return path.posix.join(relativeDir, filename);
}

function toPosixPath(value: string) {
  if (!value || value === ".") {
    return ".";
  }
  return value.split(path.sep).join(path.posix.sep);
}

function renderJsonMarkdown(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const fence = buildMarkdownFence(json);
  return `${fence}json\n${json}\n${fence}`;
}

function buildMarkdownFence(content: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}
