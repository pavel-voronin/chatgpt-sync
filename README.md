# chatgpt-sync

Exports ChatGPT conversations from an authenticated Chrome profile to Markdown files on disk.

## Output

- `output/` for Markdown files
- `output/assets/` for attachments
- `output/index.json` for sync state

## Usage

Before the first run, set `CHATGPT_SYNC_BOOTSTRAP_MODE` to choose the bootstrap strategy:

- `count` - first scan exports the latest `CHATGPT_SYNC_BOOTSTRAP_COUNT` chats.
- `days` - first scan exports chats newer than `CHATGPT_SYNC_BOOTSTRAP_DAYS` days.
- `full` - first scan exports the full conversation list.

`npm start`
