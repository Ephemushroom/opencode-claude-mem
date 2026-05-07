# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-05-07

### Added

- Added auto-start: when the plugin is loaded and the Claude-Mem worker is not
  already healthy, it spawns `bunx claude-mem start` once per OpenCode process
  and polls `/api/health` for ~8 seconds for the worker to come up. Skips when
  `bun` is not on PATH or the worker is already running. Fully fail-safe: any
  spawn / health failure leaves OpenCode running normally.
- Added `event` handler for `message.updated` so assistant message text is
  captured as `assistant_message` observations, mirroring the official
  `claude-mem` OpenCode plugin (`npx claude-mem install --ide opencode`).
  Streaming chunks are debounced (250ms) into a single observation per turn to
  avoid flooding the worker.
- Added `event` handler for `file.edited` so file edits are forwarded as
  `file_edit` observations.
- Added `event` handler for `session.compacted` to trigger summarization with
  the most recent user/assistant message pair.
- Added `event` handler for `session.deleted` so the worker is told to
  `completeSession` when OpenCode removes a session. This prevents `sdk_sessions`
  rows from staying in `'active'` and accumulating stale `pending_messages`
  rows ("queueDepth stuck at 244" symptom).

### Changed

- `session.idle` and `session.deleted` now flush any pending debounced
  assistant-message buffer before summarizing/completing.
- `extractTextFromParts` now skips `synthetic` and `ignored` parts so injected
  context lines and tool placeholders are not stored as assistant text.
- Worker offline toast now mentions `bunx claude-mem start` so users have a
  one-line recovery path when auto-start is unavailable.

## [0.2.5]

### Added

- Added `experimental.session.compacting` support so Claude-Mem context is
  preserved when OpenCode compacts long sessions.
- Added observation hardening in the plugin layer with a broader low-value tool
  skip list for meta and Claude-Mem search tools.
- Added stripping of `<claude-mem-context>` and `<private>` tags before storing
  observation input and output.
- Added UTF-8 byte-based truncation for oversized observation payloads to reduce
  token waste and avoid sending unbounded tool output to the worker.

### Changed

- Reworked `README.md` into a more product-style guide with clearer quick start,
  architecture, usage, differences, and troubleshooting sections.
- Clarified project scope in documentation: this plugin is a thin OpenCode
  adapter for an existing Claude-Mem installation and does not manage worker
  setup, slash commands, or skill installation.
