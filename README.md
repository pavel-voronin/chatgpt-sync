# chatgpt-sync

Syncing ChatGPT conversations from an authenticated Chrome profile to Markdown files on disk.

## Usage

### First run

Before the first run, set `CHATGPT_SYNC_BOOTSTRAP_MODE` to choose the bootstrap strategy:

- `count` - first scan exports the latest `CHATGPT_SYNC_BOOTSTRAP_COUNT` chats.
- `days` - first scan exports chats newer than `CHATGPT_SYNC_BOOTSTRAP_DAYS` days.
- `full` - first scan exports the full conversation list.

### Normal run

`npm start`

## Output

- `output/` as the workspace root for Markdown files and sync state
- `output/index.json` for sync state

## Environment

- `CHATGPT_SYNC_CDP_HTTP` sets the Chrome DevTools endpoint. Default: `http://127.0.0.1:9222`
- `CHATGPT_SYNC_WORKSPACE_DIR` sets the workspace root. Default: `./output`
- `CHATGPT_SYNC_INBOX_DIR` sets where new Markdown files are created inside the workspace. Default: workspace root
- `CHATGPT_SYNC_ASSET_STRATEGY` controls asset placement. Default: `fixed-folder`
  Valid values: `fixed-folder`, `same-folder`, `vault-root`, `current-folder-subfolder`
- `CHATGPT_SYNC_ASSET_SUBDIR` configures the subfolder name for `current-folder-subfolder`. Default: `assets`
- `CHATGPT_SYNC_ASSET_FIXED_DIR` configures the target folder for `fixed-folder`. Default: `assets`
- `CHATGPT_SYNC_MODE` selects the normal sync mode. Default: `incremental`
  Valid values: `incremental`, `full`, `days`, `count`
- `CHATGPT_SYNC_LIST_LIMIT` sets the page size for conversation list fetches. Default: `28`
- `CHATGPT_SYNC_COUNT` sets the conversation limit for `count` mode. Default: `50`
- `CHATGPT_SYNC_DAYS` sets the age window in days for `days` mode. Default: `14`
- `CHATGPT_SYNC_OVERLAP_MINUTES` sets the overlap window for `incremental` mode. Default: `60`
- `CHATGPT_SYNC_BOOTSTRAP_MODE` selects the first-run bootstrap mode. Required on the first run.
  Valid values: `count`, `days`, `full`
- `CHATGPT_SYNC_BOOTSTRAP_COUNT` sets the conversation limit for bootstrap `count` mode. Default: `50`
- `CHATGPT_SYNC_BOOTSTRAP_DAYS` sets the age window in days for bootstrap `days` mode. Default: `14`
- `CHATGPT_SYNC_CONVERSATION_ID` exports a single conversation by id instead of running a list sync. Default: unset
