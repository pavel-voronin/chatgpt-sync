import { DEFAULT_TIMEOUT_MS } from "./config";
import type { BrowserClient, CapturedResponse } from "./types";

type CdpResponseMeta = { url: string; mimeType: string };

const CHATGPT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const CHATGPT_PRELOAD_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
window.chrome = window.chrome || { runtime: {} };
`;

type ChromeTab = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};

export async function connect(wsUrl: string): Promise<BrowserClient> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();
  let nextId = 1;

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };

    if (typeof msg.id !== "number") {
      if (typeof msg.method === "string" && msg.params) {
        const set = listeners.get(msg.method);
        if (set) {
          for (const handler of set) {
            handler(msg.params);
          }
        }
      }
      return;
    }

    const item = pending.get(msg.id);
    if (!item) {
      return;
    }
    pending.delete(msg.id);
    if (msg.error) {
      item.reject(new Error(msg.error.message ?? "CDP error"));
      return;
    }
    item.resolve(msg.result ?? {});
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("CDP WebSocket error")),
      { once: true },
    );
  });

  return {
    send(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method: string, handler: (params: Record<string, unknown>) => void) {
      const set = listeners.get(method) ?? new Set();
      set.add(handler);
      listeners.set(method, set);
      return () => {
        const current = listeners.get(method);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          listeners.delete(method);
        }
      };
    },
    close() {
      ws.close();
    },
  };
}

export async function ensureSingleChatgptTab(
  cdpHttpBase: string,
): Promise<ChromeTab> {
  const tabs = (await fetch(`${cdpHttpBase}/json/list`).then((res) =>
    res.json(),
  )) as ChromeTab[];

  const pageTabs = tabs.filter((tab) => tab.type === "page");
  const chatgptTabs = pageTabs.filter((tab) => tab.url.includes("chatgpt.com"));
  const selected = chatgptTabs[0] ?? null;

  if (chatgptTabs.length === 0) {
    return (await fetch(`${cdpHttpBase}/json/new?about:blank`, {
      method: "PUT",
    }).then((res) => res.json())) as ChromeTab;
  }

  for (const tab of chatgptTabs.slice(1)) {
    await fetch(`${cdpHttpBase}/json/close/${tab.id}`).catch(() => undefined);
  }

  return selected;
}

export async function initializeChatgptSession(cdp: BrowserClient) {
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await cdp.send("Network.setUserAgentOverride", {
    userAgent: CHATGPT_USER_AGENT,
    platform: "MacIntel",
    acceptLanguage: "en-US,en",
  });

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: CHATGPT_PRELOAD_SCRIPT,
  });
}

export async function captureNavigationResponses(
  cdp: BrowserClient,
  url: string,
  matcher: (responseUrl: string) => boolean,
  isReady: (responses: Map<string, CapturedResponse>) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const requestUrls = new Map<string, string>();
  const responseMeta = new Map<string, CdpResponseMeta>();
  const responses = new Map<string, CapturedResponse>();
  const pendingBodies: Array<Promise<void>> = [];

  const offRequest = cdp.on("Network.requestWillBeSent", (params) => {
    const requestId = String(params.requestId ?? "");
    const request = params.request as { url?: string } | undefined;
    if (!requestId || !request?.url) return;
    requestUrls.set(requestId, request.url);
  });
  const offResponse = cdp.on("Network.responseReceived", (params) => {
    const requestId = String(params.requestId ?? "");
    const response = params.response as
      | { url?: string; mimeType?: string }
      | undefined;
    if (!requestId || !response?.url) return;
    responseMeta.set(requestId, {
      url: response.url,
      mimeType: response.mimeType || "",
    });
  });
  const offFinish = cdp.on("Network.loadingFinished", async (params) => {
    const requestId = String(params.requestId ?? "");
    const response = responseMeta.get(requestId);
    const responseUrl = response?.url || requestUrls.get(requestId) || "";
    if (!responseUrl || !matcher(responseUrl)) {
      return;
    }
    if (responses.has(responseUrl)) {
      return;
    }

    const promise = (async () => {
      try {
        const bodyResult = (await cdp.send("Network.getResponseBody", {
          requestId,
        })) as { body?: string; base64Encoded?: boolean } | undefined;
        if (!bodyResult?.body) {
          return;
        }
        responses.set(responseUrl, {
          url: responseUrl,
          mimeType: response?.mimeType || "",
          body: bodyResult.body,
          base64Encoded: Boolean(bodyResult.base64Encoded),
        });
      } catch {
        // Ignore transient response body read errors.
      }
    })();
    pendingBodies.push(promise);
  });

  await cdp.send("Page.navigate", { url });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isReady(responses)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await Promise.allSettled(pendingBodies);

  offRequest();
  offResponse();
  offFinish();

  return responses;
}
