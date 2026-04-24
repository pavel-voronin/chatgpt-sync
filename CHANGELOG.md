# Changelog

## 0.8.1

- fix(chatgpt): render current conversation branch and canvas textdoc updates

## 0.8.0

- feat(chatgpt): render citation, entity, nav list, and source annotations as Markdown

## 0.7.0

- feat(chatgpt): render Deep Research reports from embedded widget state
- docs: document a count bootstrap example

## 0.6.0

- feat(chatgpt): optionally dump raw conversation JSON next to Markdown

## 0.5.0

- feat(chatgpt): optionally render unknown conversation parts as JSON

## 0.4.0

- refactor(chatgpt): drive sync from workspace files

## 0.3.1

- refactor(chatgpt): remove redundant export metadata

## 0.3.0

- fix: enable headless Chrome for sync startup
- fix: run sync from `npm start` instead of the scaffold stub
- fix: initialize ChatGPT tabs through CDP before navigation
- fix: default CDP endpoint to `127.0.0.1:9222`

## 0.2.0

- refactor(chatgpt): split sync into scan and export phases
- chore: remove unused build tooling and update docs

## 0.1.0

- Initial ChatGPT export pipeline.
- Markdown export to disk.
- Attachment download support.
- Local sync index.
