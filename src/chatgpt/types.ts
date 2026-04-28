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
  status?: number;
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

export type ConversationSyncStatus =
  | "pending"
  | "exported"
  | "removed"
  | "unavailable";

export type AssetStrategy =
  | "vault-root"
  | "same-folder"
  | "current-folder-subfolder"
  | "fixed-folder";

export type ApiConversation = {
  title?: string;
  mapping?: Record<string, unknown>;
  current_node?: string;
};

export type ChatgptIndex = {
  watermark: string | null;
  backend_lock_until?: string | null;
  backend_lock_reason?: string | null;
  conversations: Record<string, ChatgptIndexRecord>;
};

export type ChatgptIndexRecord = {
  summary: ConversationSummary;
  status: ConversationSyncStatus;
  updated_at: string | null;
};
