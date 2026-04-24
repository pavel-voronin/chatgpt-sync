export type BrowserClient = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (
    method: string,
    handler: (params: Record<string, unknown>) => void,
  ) => () => void;
  close: () => void;
};

export type CapturedResponse = {
  url: string;
  mimeType: string;
  body: string;
  base64Encoded: boolean;
};

export type ConversationSummary = {
  id: string;
  title: string;
  create_time?: string;
  update_time?: string;
  pinned_time?: string | null;
  is_archived?: boolean;
  is_starred?: boolean | null;
  is_temporary_chat?: boolean | null;
  is_do_not_remember?: boolean | null;
  memory_scope?: string | null;
  [key: string]: unknown;
};

export type SyncMode = "incremental" | "full" | "days" | "count";

export type SyncBootstrapMode = "count" | "days" | "full";

export type ApiConversation = {
  title?: string;
  mapping?: Record<string, unknown>;
};

export type ChatgptIndex = {
  watermark: string | null;
  conversations: Record<string, ChatgptIndexRecord>;
};

export type ChatgptIndexRecord = {
  summary: ConversationSummary;
  status: "pending" | "exported";
  updated_at: string | null;
  file_path: string;
  asset_dir: string;
  source_url: string;
};
