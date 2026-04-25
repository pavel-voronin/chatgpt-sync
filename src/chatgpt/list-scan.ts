import type {
  BrowserClient,
  ConversationSummary,
  SyncBootstrapMode,
  SyncMode,
} from "./types";
import { BackendRequestError } from "./errors";

type ConversationListResponse = {
  items?: ConversationSummary[];
  total?: number;
  limit?: number;
  offset?: number;
  cursor?: string | null;
};

export type ConversationScanPlan = {
  mode: SyncMode;
  effectiveMode: SyncMode | SyncBootstrapMode;
  pageLimit: number;
  countLimit: number | null;
  daysLimit: number | null;
  overlapMinutes: number;
  cutoffAt: string | null;
  selectedCount: number;
  scannedPages: number;
  newestUpdateTime: string | null;
  oldestUpdateTime: string | null;
};

export type ConversationScanProgress = {
  offset: number;
  pageLimit: number;
  scannedPages: number;
  pageItems: number;
  selectedCount: number;
  targetCount: number | null;
  total: number | null;
  stopReason: "count" | "cutoff" | "empty-page" | "last-page" | null;
};

export async function planConversationSummaries(
  page: BrowserClient,
  params: {
    mode: SyncMode;
    pageLimit: number;
    countLimit: number;
    daysLimit: number;
    overlapMinutes: number;
    watermark: string | null;
    bootstrapMode: SyncBootstrapMode | null;
    bootstrapCount: number;
    bootstrapDays: number;
    pageDelayMs: number;
    pageJitterMs: number;
    requestHeaders?: Record<string, string>;
    onPageItems?: (items: ConversationSummary[]) => void | Promise<void>;
    onProgress?: (progress: ConversationScanProgress) => void;
    onPageDelay?: (delayMs: number, nextOffset: number) => void;
  },
): Promise<ConversationScanPlan> {
  const effectiveMode: SyncMode | SyncBootstrapMode | null = params.watermark
    ? params.mode
    : params.bootstrapMode;
  if (!effectiveMode) {
    throw new Error(
      "A bootstrap strategy must be set before the first scan can run",
    );
  }

  const cutoffAt = resolveCutoffAt({
    mode: effectiveMode,
    watermark: params.watermark,
    overlapMinutes: params.overlapMinutes,
    daysLimit: params.daysLimit,
    bootstrapDays: params.bootstrapDays,
  });
  const countLimit = resolveCountLimit({
    mode: effectiveMode,
    countLimit: params.countLimit,
    bootstrapCount: params.bootstrapCount,
    watermark: params.watermark,
  });
  const daysLimit = resolveDaysLimit({
    mode: effectiveMode,
    daysLimit: params.daysLimit,
    watermark: params.watermark,
    bootstrapDays: params.bootstrapDays,
  });
  const fallbackTargetCount = countLimit;

  let offset = 0;
  let selectedCount = 0;
  let scannedPages = 0;
  let newestUpdateTime: string | null = null;
  let oldestUpdateTime: string | null = null;
  let stopBecauseCount = false;
  let stopBecauseCutoff = false;
  let stopReason: ConversationScanProgress["stopReason"] = null;

  while (true) {
    const response = await fetchConversationListPage(
      page,
      offset,
      params.pageLimit,
      params.requestHeaders,
    );
    scannedPages += 1;
    const targetCount = fallbackTargetCount ?? response.total ?? null;
    const pageItems = response.items || [];
    if (pageItems.length === 0) {
      stopReason = "empty-page";
      params.onProgress?.({
        offset,
        pageLimit: params.pageLimit,
        scannedPages,
        pageItems: 0,
        selectedCount,
        targetCount,
        total: response.total ?? null,
        stopReason,
      });
      break;
    }

    const selectedPageItems: ConversationSummary[] = [];
    for (const item of pageItems) {
      const normalized = normalizeConversationSummary(item);
      selectedPageItems.push(normalized);
      selectedCount += 1;
      newestUpdateTime = newestUpdateTime || normalized.update_time || null;
      oldestUpdateTime = normalized.update_time || oldestUpdateTime;
      if (countLimit !== null && selectedCount >= countLimit) {
        stopBecauseCount = true;
        stopReason = "count";
        break;
      }
      if (
        cutoffAt &&
        normalized.update_time &&
        compareIso(normalized.update_time, cutoffAt) <= 0
      ) {
        stopBecauseCutoff = true;
        stopReason = "cutoff";
        break;
      }
    }

    if (!stopReason && pageItems.length < params.pageLimit) {
      stopReason = "last-page";
    }

    if (selectedPageItems.length > 0) {
      await params.onPageItems?.(selectedPageItems);
    }

    params.onProgress?.({
      offset,
      pageLimit: params.pageLimit,
      scannedPages,
      pageItems: pageItems.length,
      selectedCount,
      targetCount,
      total: response.total ?? null,
      stopReason,
    });

    if (stopBecauseCount || stopBecauseCutoff) {
      break;
    }

    if (pageItems.length < params.pageLimit) {
      break;
    }

    offset += params.pageLimit;
    await waitBetweenListPages(
      params.pageDelayMs,
      params.pageJitterMs,
      offset,
      params.onPageDelay,
    );
  }

  return {
    mode: params.mode,
    effectiveMode,
    pageLimit: params.pageLimit,
    countLimit,
    daysLimit,
    overlapMinutes: params.overlapMinutes,
    cutoffAt,
    selectedCount,
    scannedPages,
    newestUpdateTime,
    oldestUpdateTime,
  };
}

async function waitBetweenListPages(
  delayMs: number,
  jitterMs: number,
  nextOffset: number,
  onPageDelay: ((delayMs: number, nextOffset: number) => void) | undefined,
) {
  const effectiveDelayMs = delayMs + randomJitterMs(jitterMs);
  if (effectiveDelayMs <= 0) {
    return;
  }
  onPageDelay?.(effectiveDelayMs, nextOffset);
  await new Promise((resolve) => setTimeout(resolve, effectiveDelayMs));
}

function randomJitterMs(maxJitterMs: number) {
  if (maxJitterMs <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * (maxJitterMs + 1));
}

async function fetchConversationListPage(
  page: BrowserClient,
  offset: number,
  limit: number,
  requestHeaders: Record<string, string> = {},
): Promise<ConversationListResponse> {
  const payload = (await page.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `(${function browserFetchConversationList(
      offset: number,
      limit: number,
      headers: Record<string, string>,
    ) {
      return (async () => {
        const response = await fetch(
          "/backend-api/conversations?offset=" +
            offset +
            "&limit=" +
            limit +
            "&order=updated&is_archived=false&is_starred=false",
          {
            credentials: "include",
            headers,
          },
        );
        const json = (await response.json()) as {
          items?: unknown[];
          total?: number;
          limit?: number;
          offset?: number;
          cursor?: string | null;
        };
        return {
          ok: response.ok,
          status: response.status,
          json,
        };
      })();
    }.toString()})(${JSON.stringify(offset)}, ${JSON.stringify(limit)}, ${JSON.stringify(
      normalizeConversationListHeaders(requestHeaders),
    )})`,
  })) as {
    result?: {
      value?: {
        ok?: boolean;
        status?: number;
        json?: ConversationListResponse;
      };
    };
  };

  const value = payload.result?.value;
  if (!value || !value.ok) {
    throw new BackendRequestError(
      `Could not fetch conversation list page offset=${offset} limit=${limit} status=${value?.status ?? "unknown"}`,
      value?.status ?? null,
    );
  }

  return value.json || {};
}

function normalizeConversationSummary(
  summary: ConversationSummary,
): ConversationSummary {
  return {
    ...summary,
    id: String(summary.id || ""),
    title: String(summary.title || ""),
  };
}

function resolveCutoffAt(params: {
  mode: SyncMode | SyncBootstrapMode;
  watermark: string | null;
  overlapMinutes: number;
  daysLimit: number;
  bootstrapDays: number;
}) {
  if (params.mode === "full" || params.mode === "count") {
    return null;
  }

  const base =
    params.mode === "incremental"
      ? params.watermark
      : toCutoffByDays(
          params.mode === "days"
            ? params.watermark
              ? params.daysLimit
              : params.bootstrapDays
            : params.bootstrapDays,
        );
  if (!base) {
    return null;
  }

  if (params.mode === "incremental") {
    return subtractMinutes(base, params.overlapMinutes);
  }

  return base;
}

function resolveCountLimit(params: {
  mode: SyncMode | SyncBootstrapMode;
  countLimit: number;
  bootstrapCount: number;
  watermark: string | null;
}) {
  if (params.mode === "count") {
    return params.watermark ? params.countLimit : params.bootstrapCount;
  }
  if (params.mode === "incremental") {
    return null;
  }
  if (params.mode === "full" || params.mode === "days") {
    return null;
  }
  return params.bootstrapCount;
}

function resolveDaysLimit(params: {
  mode: SyncMode | SyncBootstrapMode;
  daysLimit: number;
  watermark: string | null;
  bootstrapDays: number;
}) {
  if (params.mode === "days") {
    return params.watermark ? params.daysLimit : params.bootstrapDays;
  }
  if (
    params.mode === "incremental" ||
    params.mode === "count" ||
    params.mode === "full"
  ) {
    return null;
  }
  return params.bootstrapDays;
}

function toCutoffByDays(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function subtractMinutes(iso: string, minutes: number) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) {
    return iso;
  }
  return new Date(time - minutes * 60 * 1000).toISOString();
}

function compareIso(a: string, b: string) {
  return new Date(a).getTime() - new Date(b).getTime();
}

function normalizeConversationListHeaders(headers: Record<string, string>) {
  return {
    authorization: headers.authorization || headers.Authorization || "",
    "oai-client-build-number":
      headers["oai-client-build-number"] ||
      headers["OAI-CLIENT-BUILD-NUMBER"] ||
      "",
    "oai-client-version":
      headers["oai-client-version"] || headers["OAI-CLIENT-VERSION"] || "",
    "oai-device-id": headers["oai-device-id"] || headers["OAI-DEVICE-ID"] || "",
    "oai-language": headers["oai-language"] || headers["OAI-LANGUAGE"] || "",
    "oai-session-id":
      headers["oai-session-id"] || headers["OAI-SESSION-ID"] || "",
    "x-openai-target-path": "/backend-api/conversations",
    "x-openai-target-route": "/backend-api/conversations",
    referer: "https://chatgpt.com/",
  };
}
