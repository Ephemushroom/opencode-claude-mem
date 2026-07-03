# opencode-claude-mem

Persistent memory for [OpenCode](https://opencode.ai), powered by
[Claude-Mem](https://github.com/thedotmack/claude-mem).

Share the same Claude-Mem worker, database, and search tools between Claude Code
and OpenCode. Once connected, previous observations and summaries are injected
into new OpenCode sessions automatically.

> **Note:** This plugin is a thin OpenCode adapter for an existing Claude-Mem
> installation. It does **not** install Claude-Mem, manage slash commands, or
> register Claude Code MCP servers for you.

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
- **Auto-Start** — When the plugin loads and the Claude-Mem worker is not
  already running, it spawns `bunx claude-mem start` once per OpenCode process
  (skipped silently if `bun` is not on `PATH` or the worker is already up).
- **Automatic Context Injection** — Injects relevant project memory into the
  system prompt for new OpenCode turns.
- **Compaction Support** — Re-injects memory context during OpenCode session
  compaction so long conversations keep their historical context.
- **Observation Capture** — Sends tool observations to Claude-Mem for future
  retrieval and summarization.
- **Native Memory Tools** — Exposes `mem-search`, `mem-timeline`, and
  `mem-get-observations` OpenCode tools backed by the Claude-Mem worker API,
  covering the full search → timeline → details workflow without the Claude
  Code compatibility bridge or an MCP server.
- **Sidebar Status** — Registers a TUI sidebar panel ("Memory") showing worker
  health, project, observation/summary/session counts, and processing queue
  depth, refreshed every few seconds.
- **Observation Hardening** — Skips low-value meta tools, strips
  `<claude-mem-context>` and `<private>` tags before storage, and truncates
  oversized observation payloads by UTF-8 byte size.
- **Graceful Degradation** — If the worker is offline and cannot be started,
  the plugin fails open and OpenCode continues to work normally.

## How It Works

```
OpenCode session
    |
    |-- plugin loads
    |   '-- connect to Claude-Mem worker from env/settings/default endpoint
    |
    |-- tool(mem-search) ............... search memory via worker API
    |-- session.created ................ track session + reset cache
    |-- chat.message ................... init session with real user prompt
    |-- tool.execute.after ............. send tool observation
    |-- system.transform ............... inject memory into system prompt
    |-- session.compacting ............. preserve memory during compaction
    |-- message.updated ................ capture assistant text (debounced)
    |-- file.edited .................... record file edit observation
    |-- session.compacted .............. summarize after compaction
    |-- session.idle ................... flush + summarize
    '-- session.deleted ................ flush + complete (no zombie sessions)
```

The plugin is intentionally small. It only adapts OpenCode hook events to the
Claude-Mem worker HTTP API. All indexing, summarization, memory search, and
storage stay in upstream Claude-Mem.

## Architecture

```
OpenCode <-> Plugin (this repo) <-> Claude-Mem Worker <-> SQLite + ChromaDB
```

The worker endpoint is resolved in this order: `CLAUDE_MEM_WORKER_HOST` /
`CLAUDE_MEM_WORKER_PORT` environment variables, then
`~/.claude-mem/settings.json`, then `127.0.0.1:37777`.

### Hook Mapping

| Claude Code | OpenCode plugin | Purpose |
|---|---|---|
| `SessionStart` | `experimental.chat.system.transform` | Inject memory context |
| `SessionStart` | `experimental.session.compacting` | Preserve memory during compaction |
| `UserPromptSubmit` | `chat.message` | Initialize session with real user prompt |
| `PostToolUse` | `tool.execute.after` | Capture tool observations |
| Claude-Mem MCP `search` | `tool` (`mem-search`) | Search memory from OpenCode |
| Claude-Mem MCP `timeline` | `tool` (`mem-timeline`) | Chronological context around an observation |
| Claude-Mem MCP `get_observations` | `tool` (`mem-get-observations`) | Fetch full observation details by ID |
| _(streaming)_ | `event` (`message.updated`) | Capture assistant text (debounced) |
| _(streaming)_ | `event` (`file.edited`) | Record file edit observations |
| _(compaction)_ | `event` (`session.compacted`) | Summarize after OpenCode compacts |
| `Stop` | `event` (`session.idle`) | Flush + summarize |
| `SessionEnd` | `event` (`session.deleted`) | Flush + complete (no zombie active rows) |

### Worker API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/context/inject?project={name}` | Fetch formatted memory context |
| `POST` | `/api/sessions/init` | Initialize session |
| `POST` | `/api/sessions/observations` | Store tool observation |
| `POST` | `/api/sessions/summarize` | Trigger summarization |
| `POST` | `/api/sessions/complete` | Complete session |
| `GET` | `/api/search?query={query}&project={name}` | Search memory |
| `GET` | `/api/timeline?project={name}&anchor={id}` | Chronological context around an observation |
| `POST` | `/api/observations/batch` | Fetch full observation details by ID |
| `GET` | `/api/stats` + `/api/processing-status` | Sidebar status panel |

Session and observation writes include `platformSource: "opencode"` so
Claude-Mem can attribute new OpenCode memories separately from Claude Code,
while context injection and `mem-search` still search the shared project memory.

## Installation

### Prerequisites

- [Claude Code](https://claude.com/claude-code) with
  [Claude-Mem](https://github.com/thedotmack/claude-mem) installed
- [OpenCode](https://opencode.ai) with plugin support
- A running Claude-Mem worker (default `127.0.0.1:37777`, or your
  `CLAUDE_MEM_WORKER_HOST` / `CLAUDE_MEM_WORKER_PORT` settings)

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
- **Memory search** — The `mem-search` tool queries the worker's `/api/search`
  endpoint for the current project.
- **Assistant message capture** — Assistant text from `message.updated` is
  buffered with 250ms debounce per session and sent as a single
  `assistant_message` observation per turn (avoids streaming-chunk floods).
- **File edit capture** — `file.edited` events are forwarded as `file_edit`
  observations (path only; OpenCode does not include diff in the event).
- **Session summarization** — On `session.compacted` and `session.idle`, the
  plugin flushes any pending assistant buffer, fetches the latest user and
  assistant messages, and asks Claude-Mem to summarize them.
- **Session lifecycle hygiene** — On `session.deleted` the plugin tells the
  worker to `completeSession`, preventing zombie `'active'` rows from
  accumulating stale `pending_messages` (the "queueDepth never decreases"
  failure mode).

## Memory Tools

This plugin provides three native OpenCode tools backed by the Claude-Mem
worker's HTTP API. They cover the same search → timeline → details workflow as
the upstream Claude-Mem MCP server, without requiring an MCP server or the
Claude Code compatibility bridge:

- **`mem-search`** — `GET /api/search`. Returns a formatted index of matching
  observations (with IDs) for the current project.
- **`mem-timeline`** — `GET /api/timeline`. Given an observation ID as `anchor`
  (or a `query` to locate one), returns the chronological records around it.
- **`mem-get-observations`** — `POST /api/observations/batch`. Fetches full
  observation details for a list of IDs (e.g. IDs surfaced in the injected
  memory context or by `mem-search`).

Claude Code's claude-mem plugin also registers an MCP server through its own
`.mcp.json`. OpenCode does not automatically load Claude Code plugin MCP
servers. If you previously saw Claude-Mem MCP tools in OpenCode, they were most
likely supplied by a Claude Code compatibility bridge such as oh-my-openagent.
Disabling that bridge for `claude-mem@thedotmack` removes those bridged MCP
tools; the three `mem-*` tools above are the native replacements inside this
plugin, so a separately configured MCP server is not required.

## Sidebar Status

When running in the OpenCode TUI, the plugin registers a sidebar panel titled
**Memory** via its `./tui` export. It polls `/api/stats` and
`/api/processing-status` every few seconds and shows worker health, the current
project, observation/summary/session counts, and the processing queue depth. The
panel fails open — if the worker is offline it simply shows `worker offline` and
never blocks the TUI. Requires OpenCode's `@opentui/solid` runtime; if that is
unavailable the panel is skipped silently.

## Key Implementation Details

- **Thin client architecture** — `src/index.ts` handles OpenCode hooks and
  session state; `src/worker-client.ts` is a static HTTP client.
- **No console logging** — The plugin never writes to `console.*` because that
  can corrupt the OpenCode TUI.
- **Deferred toast** — Health toasts only happen after hook execution begins,
  avoiding startup crashes caused by early TUI access.
- **Real prompt initialization** — `chat.message` sends the actual user prompt
  to Claude-Mem instead of a synthetic placeholder.
- **OpenCode attribution** — Session, observation, summarize, and complete
  payloads include `platformSource: "opencode"`.
- **Worker endpoint resolution** — The plugin reads `CLAUDE_MEM_WORKER_HOST` /
  `CLAUDE_MEM_WORKER_PORT`, then `~/.claude-mem/settings.json`, then defaults to
  `127.0.0.1:37777`.
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
- **PreToolUse file context** — Claude Code's native `PreToolUse Read`
  `file-context` hook is not mirrored because the current OpenCode plugin
  `tool.execute.before` API only lets plugins alter tool args; it has no channel
  to inject extra LLM context before the tool call.

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

The plugin will try to launch the worker via `bunx claude-mem start` once on
plugin load. If that toast still appears:

- Confirm `bun` is on your `PATH` — `bun --version` should print a version.
- Confirm `claude-mem` is installed for `bunx`/`npx` — run
  `bunx claude-mem --version` once to populate the cache.
- On Windows after a forced kill, port `37777` may stay in `TIME_WAIT` for
  30-120 seconds; wait it out or restart Claude Code.
- Restart Claude Code to bring Claude-Mem back up via its own supervisor.
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

### Memory tools are unavailable

- Use the built-in `mem-search`, `mem-timeline`, and `mem-get-observations`
  tools exposed by this plugin — they cover the full Claude-Mem search workflow
  natively, so a separate MCP server is not required.
- If the tools return `worker is offline`, confirm the worker health endpoint
  responds (see above).

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
