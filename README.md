# chatgpt-sync

Syncing ChatGPT conversations from an authenticated Chrome profile to Markdown files on disk.

## Requirements

- Google Chrome must be running with a Chrome DevTools Protocol (CDP) endpoint enabled.
- The CDP endpoint must be reachable through `CHATGPT_SYNC_CDP_HTTP`. Default: `http://127.0.0.1:9222`
- The Chrome profile used by that browser must already be authenticated in ChatGPT.

Start a dedicated headless Chrome instance (MacOS):

```bash
open -na "/Applications/Google Chrome.app" --args \
  --headless \
  --disable-gpu \
  --remote-debugging-port=9222 \
  --user-data-dir="/Users/pavel/projects/chatgpt-gateway/.chrome-profile" \
  --no-first-run \
  about:blank
```

Without this Chrome CDP endpoint the sync cannot connect to ChatGPT and will not work.

## Usage

Configuration can be passed through shell environment variables or through `.env` files in the project root.

Precedence, from highest to lowest:

- shell environment variables
- `.env.local`
- `.env`

Shell environment variables take precedence over values from files. `.env.local` is intended for machine-specific overrides and is ignored by git.

### First run

Before the first run, set `CHATGPT_SYNC_BOOTSTRAP_MODE` to choose the bootstrap strategy:

- `count` - first scan exports the latest `CHATGPT_SYNC_BOOTSTRAP_COUNT` chats.
- `days` - first scan exports chats newer than `CHATGPT_SYNC_BOOTSTRAP_DAYS` days.
- `full` - first scan exports the full conversation list.

`CHATGPT_SYNC_BOOTSTRAP_MODE=count CHATGPT_SYNC_BOOTSTRAP_COUNT=5 npm start`

### Normal run

`npm start`

### .env example

```env
CHATGPT_SYNC_CDP_HTTP=http://127.0.0.1:9222
CHATGPT_SYNC_WORKSPACE_DIR=./output
CHATGPT_SYNC_BOOTSTRAP_MODE=count
CHATGPT_SYNC_BOOTSTRAP_COUNT=5
```

See `.env.example` for all supported keys.

## Output

- `output/` as the workspace root for Markdown files and sync state
- `output/index.json` for sync state

## Settings

### Chrome connection

- `CHATGPT_SYNC_CDP_HTTP` sets the required Chrome DevTools endpoint. Default: `http://127.0.0.1:9222`

### Workspace and output

- `CHATGPT_SYNC_WORKSPACE_DIR` sets the workspace root. Default: `./output`
- `CHATGPT_SYNC_INBOX_DIR` sets where new Markdown files are created inside the workspace. Default: workspace root
- `CHATGPT_SYNC_ASSET_STRATEGY` controls asset placement. Default: `fixed-folder`
  Valid values: `fixed-folder`, `same-folder`, `vault-root`, `current-folder-subfolder`
- `CHATGPT_SYNC_ASSET_SUBDIR` configures the subfolder name for `current-folder-subfolder`. Default: `assets`
- `CHATGPT_SYNC_ASSET_FIXED_DIR` configures the target folder for `fixed-folder`. Default: `assets`

### Normal sync

- `CHATGPT_SYNC_MODE` selects the normal sync mode. Default: `incremental`
  Valid values: `incremental`, `full`, `days`, `count`
- `CHATGPT_SYNC_LIST_LIMIT` sets the page size for conversation list fetches. Default: `28`
- `CHATGPT_SYNC_LIST_PAGE_DELAY_MS` sets the delay between conversation list page requests. Default: `1000`
- `CHATGPT_SYNC_LIST_PAGE_JITTER_MS` adds random jitter to each conversation list page delay. Default: `1000`
- `CHATGPT_SYNC_COUNT` sets the conversation limit for `count` mode. Default: `50`
- `CHATGPT_SYNC_DAYS` sets the age window in days for `days` mode. Default: `14`
- `CHATGPT_SYNC_OVERLAP_MINUTES` sets the overlap window for `incremental` mode. Default: `60`
- `CHATGPT_SYNC_EXPORT_BATCH_LIMIT` sets the maximum number of pending conversations exported per run. Default: `10`; use `0` to export nothing or `-1` for unlimited.
- `CHATGPT_SYNC_EXPORT_START_DELAY_MS` sets the minimum delay between conversation export starts after the first export in a batch. Default: `2000`
- `CHATGPT_SYNC_BACKEND_LOCK_MINUTES` sets how long the index is locked after a backend refusal or missing conversation payload. Default: `10`
- `CHATGPT_SYNC_BACKEND_HEADERS_TIMEOUT_MS` sets how long startup waits for ChatGPT backend headers. Default: `30000`

### First-run bootstrap

- `CHATGPT_SYNC_BOOTSTRAP_MODE` selects the first-run bootstrap mode. Required on the first run.
  Valid values: `count`, `days`, `full`
- `CHATGPT_SYNC_BOOTSTRAP_COUNT` sets the conversation limit for bootstrap `count` mode. Default: `50`
- `CHATGPT_SYNC_BOOTSTRAP_DAYS` sets the age window in days for bootstrap `days` mode. Default: `14`

### Single conversation export

- `CHATGPT_SYNC_CONVERSATION_ID` exports a single conversation by id instead of running a list sync. Default: unset

### Debug output

- `CHATGPT_SYNC_RENDER_UNKNOWN_PARTS_AS_JSON` renders unknown `content.parts` objects as fenced JSON blocks in Markdown. Default: disabled
- `CHATGPT_SYNC_DUMP_RAW_CONVERSATION_JSON` writes the raw conversation JSON next to each synced Markdown file. Default: disabled
