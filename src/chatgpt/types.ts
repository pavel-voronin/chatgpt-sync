export type BrowserClient = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (method: string, handler: (params: Record<string, unknown>) => void) => () => void;
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
  schema_version: number;
  exported_root: string;
  conversations_file_limit: number;
  sync: {
    last_sync_at: string | null;
    last_run_started_at: string | null;
    last_run_completed_at: string | null;
    last_run_mode: SyncMode | null;
    last_run_effective_mode: SyncMode | SyncBootstrapMode | null;
    last_run_page_limit: number | null;
    last_run_limit: number | null;
    last_run_days: number | null;
    last_run_count: number | null;
    last_run_overlap_minutes: number | null;
    last_run_selected_count: number | null;
    last_run_exported_count: number | null;
    last_run_newest_update_time: string | null;
    last_run_oldest_update_time: string | null;
  };
  conversations: Record<string, ChatgptIndexRecord>;
};

export type ChatgptIndexRecord = {
  summary: ConversationSummary;
  status: "pending" | "exported";
  last_seen_at: string | null;
  last_exported_at: string | null;
  file_path: string;
  asset_dir: string;
  source_url: string;
  exported_at: string | null;
  updated_at: string | null;
  asset_count: number;
};
