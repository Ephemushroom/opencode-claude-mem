# opencode-claude-mem

OpenCode plugin for [Claude-Mem](https://github.com/thedotmack/claude-mem) persistent memory system.

Enables OpenCode to share the same memory database as Claude Code — observations, summaries, and context injection all work across both editors.

## How It Works

This plugin communicates with the Claude-Mem worker service (HTTP API on port 37777) to:

- **Capture tool observations** — every tool execution is recorded as a structured observation
- **Inject memory context** — previous session context is injected into the system prompt via `/api/context/inject`
- **Summarize sessions** — when a session goes idle, the last user/assistant messages are sent for summarization
- **Search memory** — `mem-search` tool lets the LLM query project history

## Prerequisites

- Claude-Mem worker running on port 37777 (started by Claude Code, or manually)
- OpenCode with plugin support

## Installation

```bash
# Clone and build
git clone https://github.com/YOUR_USERNAME/opencode-claude-mem.git
cd opencode-claude-mem
npm install
npm run build

# Symlink into OpenCode plugin directory
# Windows (requires admin/sudo):
sudo powershell -Command "New-Item -ItemType SymbolicLink -Path '$env:USERPROFILE\.config\opencode\plugin\claude-mem.js' -Target '$(pwd)\dist\index.js'"

# macOS/Linux:
ln -sf "$(pwd)/dist/index.js" ~/.config/opencode/plugin/claude-mem.js
```

Restart OpenCode. You should see a toast notification: "Memory active · {project}".

## After Editing Source

```bash
npm run build
# Restart OpenCode to pick up changes
```

## Architecture

```
OpenCode ←→ Plugin (this repo) ←→ Claude-Mem Worker (port 37777) ←→ SQLite + ChromaDB
```

The plugin is a thin HTTP client. All heavy lifting (LLM processing, storage, search) happens in the worker.

### Hook Mapping (Claude Code → OpenCode)

| Claude Code Hook | OpenCode Hook | Purpose |
|-----------------|---------------|---------|
| `SessionStart` → context | `experimental.chat.system.transform` | Inject memory into system prompt |
| `UserPromptSubmit` → session-init | `chat.message` | Init session with real user prompt |
| `PostToolUse` → observation | `tool.execute.after` | Capture tool executions |
| `Stop` → summarize | `event` (session.idle) | Summarize with real message content |
| `Stop` → session-complete | `event` (session.idle) | Mark session complete |

### Worker API Endpoints Used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/context/inject?project={name}` | Get formatted context for system prompt |
| `POST` | `/api/sessions/init` | Initialize session |
| `POST` | `/api/sessions/observations` | Send tool observation |
| `POST` | `/api/sessions/summarize` | Trigger summarization |
| `POST` | `/api/sessions/complete` | Complete session |
| `GET` | `/api/search?q={query}&project={name}` | Search memory |

## Key Implementation Details

- **Field name**: All worker API calls use `contentSessionId` (not `claudeSessionId`)
- **No console output**: All `console.log/warn/error` removed to avoid corrupting OpenCode TUI
- **Deferred toast**: `client.tui.showToast()` is deferred to first hook invocation (TUI not ready during plugin init)
- **Real prompt**: `chat.message` hook extracts actual user input, not hardcoded "SESSION_START"
- **Real summarize**: `session.idle` fetches last user/assistant messages via `client.session.messages()`

## License

MIT
