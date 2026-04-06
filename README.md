# opencode-claude-mem

Persistent memory for [OpenCode](https://opencode.ai), powered by
[Claude-Mem](https://github.com/thedotmack/claude-mem).

Share the same Claude-Mem worker, database, and search tools between Claude Code
and OpenCode. Once connected, previous observations and summaries are injected
into new OpenCode sessions automatically.

> **Note:** This plugin is a thin OpenCode adapter for an existing Claude-Mem
> installation. It does **not** install Claude-Mem, manage slash commands, or
> start the worker for you.

## Quick Start

1. Install and configure Claude-Mem in Claude Code.
2. Add this plugin to your `opencode.json`:

```json
{
  "plugin": ["@ephemushroom/opencode-claude-mem"]
}
```

3. Restart OpenCode.
4. Start a session — memory context will be injected automatically when the
   Claude-Mem worker is available.

## Key Features

- **Shared Memory** — Uses the same Claude-Mem worker and memory store as
  Claude Code.
- **Automatic Context Injection** — Injects relevant project memory into the
  system prompt for new OpenCode turns.
- **Compaction Support** — Re-injects memory context during OpenCode session
  compaction so long conversations keep their historical context.
- **Observation Capture** — Sends tool observations to Claude-Mem for future
  retrieval and summarization.
- **Observation Hardening** — Skips low-value meta tools, strips
  `<claude-mem-context>` and `<private>` tags before storage, and truncates
  oversized observation payloads by UTF-8 byte size.
- **Graceful Degradation** — If the worker is offline, the plugin fails open
  and OpenCode continues to work normally.

## How It Works

```
OpenCode session
    |
    |-- plugin loads
    |   '-- connect to Claude-Mem worker on port 37777
    |
    |-- session.created ................ track session + reset cache
    |-- chat.message ................... init session with real user prompt
    |-- tool.execute.after ............. send tool observation
    |-- system.transform ............... inject memory into system prompt
    |-- session.compacting ............. preserve memory during compaction
    '-- session.idle ................... summarize + complete session
```

The plugin is intentionally small. It only adapts OpenCode hook events to the
Claude-Mem worker HTTP API. All indexing, summarization, memory search, and
storage stay in upstream Claude-Mem.

## Architecture

```
OpenCode <-> Plugin (this repo) <-> Claude-Mem Worker (port 37777) <-> SQLite + ChromaDB
```

### Hook Mapping

| Claude Code | OpenCode plugin | Purpose |
|---|---|---|
| `SessionStart` | `experimental.chat.system.transform` | Inject memory context |
| `SessionStart` | `experimental.session.compacting` | Preserve memory during compaction |
| `UserPromptSubmit` | `chat.message` | Initialize session with real user prompt |
| `PostToolUse` | `tool.execute.after` | Capture tool observations |
| `Stop` | `event` (`session.idle`) | Summarize the session |
| `SessionEnd` | `event` (`session.idle`) | Mark session complete |

### Worker API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/context/inject?project={name}` | Fetch formatted memory context |
| `POST` | `/api/sessions/init` | Initialize session |
| `POST` | `/api/sessions/observations` | Store tool observation |
| `POST` | `/api/sessions/summarize` | Trigger summarization |
| `POST` | `/api/sessions/complete` | Complete session |

## Installation

### Prerequisites

- [Claude Code](https://claude.com/claude-code) with
  [Claude-Mem](https://github.com/thedotmack/claude-mem) installed
- [OpenCode](https://opencode.ai) with plugin support
- A running Claude-Mem worker on port `37777` (default)

### Step 1: Install Claude-Mem

In Claude Code:

```text
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Restart Claude Code so the worker can start and initialize its data directory.

### Step 2: Add the OpenCode Plugin

Add this plugin to your project or global `opencode.json`:

```json
{
  "plugin": ["@ephemushroom/opencode-claude-mem"]
}
```

Then restart OpenCode.

### Step 3: Verify

```bash
curl -s http://127.0.0.1:37777/api/health
```

If the worker is healthy, OpenCode should show a toast like
`Memory active · <project>` when a session starts.

## Usage

Once installed, the plugin works automatically:

- **Context injection** — Memory is injected into the system prompt on each LLM
  call, with session-level caching to avoid repeated worker requests.
- **Compaction preservation** — The same cached memory context is pushed into
  OpenCode’s compaction path so memory survives conversation compression.
- **Tool observation capture** — Tool executions are stored as observations,
  except for low-value/meta tools and Claude-Mem search tools.
- **Session summarization** — On `session.idle`, the plugin fetches the latest
  user and assistant messages and asks Claude-Mem to summarize them.

## Memory Search

Memory search is provided by Claude-Mem’s MCP server, not by this plugin.

If your OpenCode environment already has Claude-Mem MCP tools configured, the
assistant can query project memory directly with Claude-Mem’s search workflow:

1. `search(query="...")`
2. `timeline(anchor=ID)`
3. `get_observations(ids=[...])`

This plugin focuses on sending memory data to the worker and injecting returned
context back into OpenCode sessions.

## Key Implementation Details

- **Thin client architecture** — `src/index.ts` handles OpenCode hooks and
  session state; `src/worker-client.ts` is a static HTTP client.
- **No console logging** — The plugin never writes to `console.*` because that
  can corrupt the OpenCode TUI.
- **Deferred toast** — Health toasts only happen after hook execution begins,
  avoiding startup crashes caused by early TUI access.
- **Real prompt initialization** — `chat.message` sends the actual user prompt
  to Claude-Mem instead of a synthetic placeholder.
- **Real summarize payloads** — On `session.idle`, the plugin reads the latest
  session messages and sends the last user and assistant messages for summary.
- **Context caching** — Memory context is fetched once per session and reused
  across prompt injection and compaction.
- **Circular memory protection** — Injected context is wrapped in
  `<claude-mem-context>` tags, Claude-Mem MCP search tools are skipped, and
  memory-related tags are stripped before storing observations.
- **UTF-8 truncation** — Large observation outputs are capped by byte size to
  reduce token waste and avoid oversize worker payloads.
- **Field name correctness** — Worker payloads use `contentSessionId`, not
  `claudeSessionId`.

## Differences from `bloodf/opencode-mem`

This project intentionally stays smaller in scope.

- **This plugin does**: bridge OpenCode hooks to an already-installed
  Claude-Mem worker.
- **This plugin does not**: auto-install Claude-Mem, auto-edit OpenCode config,
  auto-copy skills, auto-register slash commands, or auto-start the worker.

That keeps the runtime behavior predictable and leaves worker ownership with the
upstream Claude-Mem installation.

## Troubleshooting

### No memory appears in OpenCode

- Confirm the worker is running:

```bash
curl -s http://127.0.0.1:37777/api/health
```

- Make sure Claude-Mem has already been installed and used from Claude Code.
- Start a fresh OpenCode session after the worker is healthy.

### OpenCode shows `Worker offline`

- Restart Claude Code to bring Claude-Mem back up.
- Verify the worker port is still `37777`.

### OpenCode crashes on startup

- Update to a version with deferred TUI access.
- Ensure there are no `console.log`, `console.warn`, or `console.error` calls in
  local plugin modifications.

### Observations are missing or incomplete

- Ensure the worker API payload uses `contentSessionId`.
- Be aware that low-value meta tools and Claude-Mem search tools are skipped by
  design.
- Very large tool outputs are truncated before storage.

### Memory search is unavailable

- This plugin does not configure MCP tools for you.
- Configure Claude-Mem’s MCP server separately in your OpenCode environment if
  you want in-editor memory search.

## Development

```bash
bun install
bun run build
bun run lint
bun run fmt:check
```

If you edit source code locally, rebuild and restart OpenCode to pick up the new
plugin bundle.

## License

MIT
