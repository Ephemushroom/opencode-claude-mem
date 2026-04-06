# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
