# opencode-claude-mem

OpenCode plugin for [Claude-Mem](https://github.com/thedotmack/claude-mem) persistent memory system.

Enables OpenCode to share the same memory database as Claude Code — observations, summaries, and context injection all work across both editors.

## How It Works

This plugin communicates with the Claude-Mem worker service (HTTP API on port 37777) to:

- **Inject memory context** — previous session context is injected into the system prompt on every LLM call
- **Capture tool observations** — every tool execution is recorded as a structured observation
- **Summarize sessions** — when a session goes idle, the last user/assistant messages are sent for summarization
- **Search memory** — `mem-search` tool lets the LLM query project history
- **View context on demand** — `/memory` command displays the current memory context in the chat flow

## Differences from Claude Code Version

The Claude Code version of claude-mem uses shell-based hooks where `SessionStart` stdout is automatically injected into the system prompt — one-time, at session start.

This OpenCode version works differently:

| | Claude Code | OpenCode (this plugin) |
|---|---|---|
| **Architecture** | Shell commands (`node script.js`) | JavaScript plugin API |
| **Context injection** | `SessionStart` hook stdout → system prompt (once) | `experimental.chat.system.transform` → system prompt (every LLM call) |
| **Context freshness** | Snapshot at session start | Refreshed every 60s — new observations during the conversation are picked up |
| **User-visible context** | Displayed in TUI automatically | `/memory` command to view on demand |
| **Session init** | `UserPromptSubmit` hook | `chat.message` hook with real user prompt |
| **Observations** | `PostToolUse` hook | `tool.execute.after` hook |
| **Summarization** | `Stop` hook | `session.idle` event |

The key advantage of this plugin is **live context refresh** — in long conversations, the LLM always sees the latest observations, not a stale snapshot from session start.

## Prerequisites

- [Claude Code](https://claude.com/claude-code) with [claude-mem plugin](https://github.com/thedotmack/claude-mem) installed and running
- [OpenCode](https://opencode.ai) with plugin support

## Installation

### Step 1: Install Claude-Mem (if not already)

In Claude Code terminal:

```
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Restart Claude Code. The worker service will start automatically on port 37777.

### Step 2: Add the Plugin

Add to your `opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@ephemushroom/opencode-claude-mem"]
}
```

Restart OpenCode. The plugin will be installed automatically.

### Step 3: Verify

```bash
# Check worker is running
curl -s http://127.0.0.1:37777/api/health

# Restart OpenCode — you should see toast: "Memory active · {project}"
```

## Usage

### Automatic (no action needed)

Once installed, the plugin works automatically:

- **System prompt injection** — memory context is injected into every LLM call via `experimental.chat.system.transform`. The LLM sees your project's observation history, past decisions, and session summaries. Context is cached for 60s to avoid redundant worker calls.
- **Tool observation capture** — every tool execution (file reads, edits, searches, etc.) is recorded as an observation in the memory database.
- **Session summarization** — when a session goes idle, the last user/assistant exchange is summarized and stored.
- **Toast notification** — on session start, a "Memory active · {project}" toast confirms the plugin is connected to the worker.

### `/memory` Command

Type `/memory` in the chat to display the current memory context inline. This shows you exactly what the LLM sees in its system prompt — the observation index, token economics, and session history.

### `mem-search` Tool

The LLM can use the `mem-search` tool to search project history and memory. This is available automatically — no action needed.

### Alternative: Manual Installation (from source)

If you prefer to install from source instead of npm:

```bash
git clone https://github.com/Ephemushroom/opencode-claude-mem.git
cd opencode-claude-mem
bun install
bun run build
```

Then symlink into OpenCode:

**macOS / Linux:**

```bash
mkdir -p ~/.config/opencode/plugin
ln -sf "$(pwd)/dist/index.js" ~/.config/opencode/plugin/claude-mem.js
```

**Windows (requires elevated terminal):**

```powershell
# Option A: If you have gsudo / sudo installed
sudo powershell -Command "New-Item -ItemType SymbolicLink -Path '$env:USERPROFILE\.config\opencode\plugin\claude-mem.js' -Target 'D:\path\to\opencode-claude-mem\dist\index.js'"

# Option B: Run PowerShell as Administrator
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.config\opencode\plugin\claude-mem.js" -Target "D:\path\to\opencode-claude-mem\dist\index.js"
```

---

## Windows-Specific Setup

### Python Version for ChromaDB

Claude-Mem uses ChromaDB for vector semantic search. ChromaDB's `chroma-mcp` tool requires **Python ≤ 3.13** (Pydantic V1 is incompatible with Python 3.14+).

If `uv` defaults to Python 3.14, you'll see:

```
Chroma connection failed: Chroma server not reachable.
```

**Fix — set global Python version:**

```bash
uv python pin --global 3.13
```

This creates a global `.python-version` file in `%APPDATA%\uv\` so all `uvx` calls default to 3.13.

### ChromaDB on Windows x64

The npm `chromadb` package only supports Windows ARM64, not x64. The worker will fail to start Chroma natively.

**Fix — use Python ChromaDB instead:**

```bash
# Install Python ChromaDB CLI
uv tool install chromadb --python 3.13
```

Update `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_CHROMA_MODE": "remote"
}
```

Start Chroma server manually:

```bash
chroma run --path %USERPROFILE%\.claude-mem\vector-db --host 127.0.0.1 --port 8000
```

> **Note**: Chroma server must be running before Claude Code starts. Consider creating a startup script or scheduled task.

### ChromaDB Embedding Model Crash (Bun Runtime)

After connecting to Chroma, the worker may crash with:

```
Collection setup failed: undefined is not an object
  (evaluating 'e.cacheDir = ...')
```

This happens because `@huggingface/transformers` returns `undefined` when imported through Bun's CJS shim.

**Fix — patch `worker-service.cjs`:**

Locate the bundled worker file:

```
~/.claude/plugins/cache/thedotmack/claude-mem/<version>/scripts/worker-service.cjs
```

Find this pattern (minified):

```javascript
let{env:e}=await Promise.resolve().then(()=>(F9(),N9));
```

Replace with:

```javascript
let{env:e}=await import("@huggingface/transformers");
```

Then install the dependency:

```bash
cd ~/.claude/plugins/cache/thedotmack/claude-mem/<version>
bun install
```

> ⚠️ **This patch is lost on plugin updates.** You'll need to re-apply after each claude-mem version upgrade.

### Verifying ChromaDB Works

```bash
# Check Chroma server
curl -s http://127.0.0.1:8000/api/v1/heartbeat

# Check worker health
curl -s http://127.0.0.1:37777/api/health

# Check for sync errors in worker logs
# Open http://localhost:37777 in browser for the web viewer
```

When working correctly, worker logs should show:

```
CHROMA_SYNC connected (remote mode, 127.0.0.1:8000)
```

> **ChromaDB is optional.** Without it, claude-mem falls back to SQLite FTS5 full-text search. You lose semantic/vector search but keyword search still works.

---

## Development

After editing source:

```bash
bun run build
# Restart OpenCode to pick up changes
```

If using symlink install, changes are picked up after rebuild. If using npm install, bump version and republish.

## Architecture

```
OpenCode ←→ Plugin (this repo) ←→ Claude-Mem Worker (port 37777) ←→ SQLite + ChromaDB
```

The plugin is a thin HTTP client. All heavy lifting (LLM processing, storage, search) happens in the worker.

### Hook Mapping (Claude Code → OpenCode)

| Claude Code Hook | OpenCode Hook | Purpose |
|-----------------|---------------|---------|
| `SessionStart` → context | `experimental.chat.system.transform` | Inject memory into system prompt (every LLM call, 60s cache) |
| `UserPromptSubmit` → session-init | `chat.message` | Init session with real user prompt |
| `PostToolUse` → observation | `tool.execute.after` | Capture tool executions |
| `Stop` → summarize | `event` (session.idle) | Summarize with real message content |
| `Stop` → session-complete | `event` (session.idle) | Mark session complete |
| *(no equivalent)* | `config` + `command.execute.before` | `/memory` command for user-visible context |

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

- **Field name**: All worker API calls use `contentSessionId` (not `claudeSessionId`) — using the wrong field name causes silent failures
- **No console output**: All `console.log/warn/error` removed to avoid corrupting OpenCode TUI
- **Deferred toast**: `client.tui.showToast()` is deferred to first hook invocation (TUI not ready during plugin init, calling it crashes OpenCode)
- **Real prompt**: `chat.message` hook extracts actual user input instead of hardcoded "SESSION_START"
- **Real summarize**: `session.idle` fetches last user/assistant messages via `client.session.messages()` for meaningful summaries
- **Context caching**: `getCachedContext()` wraps `WorkerClient.getContext()` with a 60s TTL cache to avoid redundant worker calls
- **Content-type handling**: Worker returns `text/plain` markdown — `getContext()` checks content-type and uses `response.text()` instead of `response.json()`
- **`/memory` command**: Registered via `config` hook, handled by `command.execute.before` — displays context as an `ignored: true` message (visible to user, not sent to LLM)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No toast on startup | Worker not running | Start Claude Code first, or check `curl http://127.0.0.1:37777/api/health` |
| "Worker offline" toast | Worker crashed or not started | Restart Claude Code |
| OpenCode crashes on startup | Plugin calling TUI too early | Update to latest version (deferred toast fix) |
| TUI display corrupted | console.log in plugin code | Ensure no console output in source |
| "SESSION_START" in prompts | Old version bug | Update — `session.created` no longer calls sessionInit |
| Chroma sync failed | Python version or Chroma not running | See [Windows-Specific Setup](#windows-specific-setup) |
| Observations not saved | Wrong field name | Ensure `contentSessionId` (not `claudeSessionId`) |

## License

MIT
