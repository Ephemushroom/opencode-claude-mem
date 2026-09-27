# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.6.2] - 2026-09-27

### Fixed

- Render the Memory sidebar title in bold in both collapsed and expanded states.
- Verify the rendered title's bold attribute across sidebar state changes.

## [0.6.0] - 2026-09-07

### Added

- Native `mem-save` in both runtimes, with privacy filtering, bounded input and
  explicit success/failure acknowledgement.
- Supplementary read-file history with Windows path normalization, per-session
  deduplication, revision tracking, bounded lookups and fail-open behavior.
- Opt-in semantic injection configured through V1/V2 plugin options or upstream
  environment/settings switches. Explicit options take precedence; default is off.

### Fixed

- Emit explicit `.js` adapter imports in the TUI bridge so the host's runtime
  prescan preserves its renderer singleton, fixing `No renderer found` in the
  actual OpenCode 2 sidebar. Add packed-host PTY render and mouse-interaction QA.
- Register each real user message ID instead of only the first prompt in a session.
  Preserve failed prompts for retry and respect V2 queued-versus-delivered messages.
- Refresh session-isolated base memory at compaction and reject stale in-flight reads.
- Flush V1 assistant observations before advancing to a new user turn, without
  dropping buffers on duplicate callbacks.
- Harden protected-tag filtering and suppress automatic capture for private/internal turns.

## [0.5.0] - 2026-09-06

### Fixed

- Repair the existing OpenCode 2 adapter against SDK `0.0.0-beta-19151`: use
  the current CLI slot claim shape, keep the sidebar reactive, and dispose event
  subscriptions and refresh work safely.
- Resolve resumed V2 session locations, isolate server-wide events, share concurrent
  initialization, and skip both hyphenated and normalized memory tool names.
- Recognize object-form CLI registrations without duplicates and leave malformed
  configuration untouched.
- Stop calling the removed Worker `/api/sessions/complete` endpoint. Session
  deletion still flushes observations and releases local state; the Worker
  completes processing itself.
- Recheck Worker health after the once-only startup attempt and retry failed
  context fetches, allowing recovery without restarting OpenCode.
- Check write responses and only report accepted summary requests as queued.

### Added

- Unified bare package configuration for OpenCode V1 and V2, including the sidebar
  without a `/cli` suffix. Thin static server/TUI bridges preserve the separate
  adapters and existing `/server`, `/tui`, `/v2`, and `/cli` consumers.
- Bare-name CLI self-healing recognizes existing legacy sidebar aliases and options
  without appending duplicates. Beta-19151 still uses `cli.json` and may need a restart.
- Packed-package QA against both installed server runtimes via an isolated local
  registry, plus a whole-host V2 sidebar loading probe and bridge rendering coverage.
- Forward OpenCode tool call IDs as `tool_use_id` and the observed assistant
  model as `observedModel` in summary requests.
- Isolated HTTP regression scenarios for lifecycle, attribution, and recovery.
- Native OpenTUI rendering scenarios and an isolated real `opencode2` runtime QA
  driver with a local model and Worker fixture.

## [0.4.3] - 2026-07-23

### Added

- Expanded the native `mem-search` tool to expose Claude-Mem's complete worker
  search filters: `project`, `platformSource`, `type`, `obs_type`, `dateStart`,
  `dateEnd`, `offset`, and `orderBy`.
- Added coverage for full parameter forwarding and date-only searches.

### Fixed

- Encode a missing search query as `query=` so date-only and filter-only searches
  work with Claude-Mem worker `13.11.0`.

### Documentation

- Documented the expanded `mem-search` contract and worker query parameters.

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
