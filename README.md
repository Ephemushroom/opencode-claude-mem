# opencode-claude-mem

Persistent memory for [OpenCode](https://opencode.ai), powered by
[Claude-Mem](https://github.com/thedotmack/claude-mem).

Share the same Claude-Mem worker, database, and memory across your coding
agents: memories written by Claude Code are visible to OpenCode, and vice
versa. Previous observations and summaries are injected into new OpenCode
sessions automatically.

```mermaid
flowchart LR
    CC[Claude Code] -->|writes as<br/>platform_source=claude| W
    OC[OpenCode<br/>+ this plugin] -->|writes as<br/>platform_source=opencode| W
    W[Claude-Mem Worker<br/>127.0.0.1:37777] --> DB[(SQLite +<br/>ChromaDB)]
    W -->|shared project memory| CC
    W -->|shared project memory| OC
```

> **Note:** This plugin is a thin OpenCode adapter for an existing Claude-Mem
> installation. It does **not** install Claude-Mem, manage slash commands, or
> register Claude Code MCP servers for you.

## Quick Start

1. Install and configure Claude-Mem in Claude Code.
2. Add this plugin to your `opencode.json` — pick the section matching your
   OpenCode version:

### OpenCode 1

```json
{
  "plugin": ["@ephemushroom/opencode-claude-mem"]
}
```

### OpenCode 2

```json
{
  "plugins": ["@ephemushroom/opencode-claude-mem/v2"]
}
```

3. Restart OpenCode.
4. Start a session — memory context is injected automatically, the `mem-*`
   tools become available, and a collapsible **Memory** section appears in the
   sidebar (both versions).

Using [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)?
See [Disable the Claude Code bridge](#using-with-oh-my-openagent-disable-the-claude-code-bridge)
to avoid running two claude-mem integrations at once.

## OpenCode 1 and 2

OpenCode 1 and OpenCode 2 install side by side (`opencode` vs `opencode2`) and
their plugin APIs are incompatible — **V1 plugins do not load in V2**. This
package ships both entrypoints in the same npm package, so each runtime loads
only its own:

| | OpenCode 1 | OpenCode 2 |
|---|---|---|
| **Binary** | `opencode` | `opencode2` |
| **Server plugin config** | `opencode.json` → `plugin` | `opencode.json` → `plugins` |
| **Server plugin entry** | `@ephemushroom/opencode-claude-mem` | `@ephemushroom/opencode-claude-mem/v2` |
| **Sidebar config** | `~/.config/opencode/tui.json` → `plugin` (self-healed) | `~/.config/opencode/cli.json` → `plugins` (self-healed) |
| **Sidebar entry** | package `./tui` export | package `./cli` export |

Both adapters talk to the same Claude-Mem worker, so memory written from V1,
V2, and Claude Code is shared. The V2 entrypoint covers the same behavior —
context injection, tool observation capture, the `mem-search`/`mem-timeline`/
`mem-get-observations` tools, session init/summarize/complete via the event
stream.

In V2, installing the server plugin
(`"plugins": ["@ephemushroom/opencode-claude-mem/v2"]`) auto-appends
`@ephemushroom/opencode-claude-mem/cli` to the `plugins` array in
`~/.config/opencode/cli.json` on first load — no manual step. To register
manually, add it yourself:

```json
{
  "plugins": ["@ephemushroom/opencode-claude-mem/cli"]
}
```

## What You Get

| Surface | What it looks like |
|---|---|
| **System prompt** | `<claude-mem-context>` block with recent observations + session summaries for the current project |
| **Tools** | `mem-search` → `mem-timeline` → `mem-get-observations` (full search workflow, no MCP server needed) |
| **Sidebar** | `▶ Memory (online, 11.7k obs)` — click to expand recent sessions and latest observations |
| **Background** | Every tool call, assistant message, and file edit captured as observations; sessions summarized on idle |

### Sidebar

The plugin registers a sidebar section styled after OpenCode's native
MCP/Context sections — borderless, click-to-toggle:

```text
▶ Memory (online, 11.7k obs)          ← collapsed (default), single line
```

```text
▼ Memory                              ← click header to expand
  • obs 11.7k · sum 2311 · ses 1186
  Recent sessions
  • 实现 tui.json 自动注册（self-heal）机制…
  • 设计 Memory 面板：跨工具记忆共享…
  Latest
  ◆ Memory 侧边栏完整通过 CI 流水线…
  ● 修复点击不展开：改用 solid-js signal…
  ⚖ 计划按原生风格重构 Memory 面板…
```

- Summary line turns **yellow** while the worker is processing (`(queue N)`)
  and **red** when offline (`(offline)`).
- Observation icons match the injected context legend: ◆ feature · ● bugfix ·
  ⚖ decision · ○ discovery · ↻ refactor · ✓ change · ⚠/⚷ security.
- Recent items are only fetched while expanded, keeping the collapsed poll
  loop cheap (stats every 5s).
- Fails open: worker offline → shows the offline state, never blocks the TUI.

The sidebar loads via the package's `./tui` export (OpenCode 1) or `./cli`
export (OpenCode 2 — registered in `~/.config/opencode/cli.json`). On startup
the plugin **self-heals the TUI config**: if it is registered as a server
plugin but missing from the TUI plugin list, it appends itself — no manual
configuration. OpenCode 1 writes into `tui.json` (symlinked files are written
through, preserving dotfiles setups); OpenCode 2 appends
`@ephemushroom/opencode-claude-mem/cli` to `cli.json`'s `plugins` array
(comment-bearing files are left untouched).

### Memory Tools

Three native OpenCode tools cover the same 3-step workflow as the upstream
Claude-Mem MCP server — no MCP server or stdio subprocess required:

```mermaid
flowchart LR
    A["mem-search<br/><i>find IDs by query</i>"] --> B["mem-timeline<br/><i>context around an ID</i>"]
    B --> C["mem-get-observations<br/><i>full details for IDs</i>"]
```

| Tool | Worker endpoint | Use it for |
|---|---|---|
| `mem-search` | `GET /api/search` | Formatted index with query, project, source, type, date, pagination, and ordering filters |
| `mem-timeline` | `GET /api/timeline` | Chronological records around an `anchor` ID (or auto-located via `query`) |
| `mem-get-observations` | `POST /api/observations/batch` | Full details for IDs — e.g. the IDs shown in the injected context |

## How It Works

```mermaid
sequenceDiagram
    participant OC as OpenCode
    participant P as Plugin
    participant W as Claude-Mem Worker

    OC->>P: plugin loads
    P->>P: self-heal tui.json / cli.json
    P->>W: health check (auto-start via bunx if down)
    OC->>P: first user prompt (chat.message / context hook)
    P->>W: POST /api/sessions/init
    OC->>P: system prompt transform / context hook
    W-->>P: GET /api/context/inject (cached per session)
    P-->>OC: inject <claude-mem-context> into system prompt
    loop during the session
        OC->>P: tool.execute.after / assistant text / file.edited
        P->>W: POST /api/sessions/observations
    end
    OC->>P: session idle / execution succeeded / compaction ended
    P->>W: POST /api/sessions/summarize
    OC->>P: session.deleted
    P->>W: POST /api/sessions/complete
```

The plugin is intentionally small: it only adapts OpenCode hook events to the
Claude-Mem worker HTTP API. All indexing, summarization, memory search, and
storage stay in upstream Claude-Mem.

### Hook Mapping (V1 ↔ V2)

The V1 and V2 entrypoints adapt the same behavior onto two different plugin
APIs:

| Behavior | OpenCode 1 | OpenCode 2 |
|---|---|---|
| Inject memory context | `experimental.chat.system.transform` | `ctx.session.hook('context')` |
| Preserve memory on compaction | `experimental.session.compacting` | _(context hook re-runs per dispatch)_ |
| Session init with user prompt | `chat.message` | `ctx.session.hook('context')` (from `event.messages`) |
| Capture tool observations | `tool.execute.after` | `ctx.tool.hook('execute.after')` |
| Custom memory tools | `tool` (`mem-search`, …) | `ctx.tool.transform` (`tools.add`) |
| Assistant text capture | `event` (`message.updated`, debounced 250ms) | `session.text.ended` event (complete text) |
| File edit observations | `event` (`file.edited`) | `ctx.tool.hook('execute.after')` |
| Summarize on idle | `event` (`session.idle`) | `session.execution.succeeded` event |
| Summarize after compaction | `event` (`session.compacted`) | `session.compaction.ended` event |
| Complete session | `event` (`session.deleted`) | `session.deleted` event |
| Sidebar slot | `api.slots.register` (`sidebar_content`) | `ctx.ui.slot('sidebar.content')` |

### Cross-Tool Memory Sharing

Writes are attributed (`platformSource: "opencode"`), reads are shared:

| Operation | Behavior |
|---|---|
| OpenCode writes | Stored as `platform_source=opencode` |
| Claude Code writes | Stored as `platform_source=claude` |
| Either reads (inject/search) | Sees **all** memory for the project, regardless of source |

The sharing key is the **project name** (worktree directory name) — work in
the same project directory and memory flows both ways.

## Installation

### Prerequisites

- [Claude Code](https://claude.com/claude-code) with
  [Claude-Mem](https://github.com/thedotmack/claude-mem) installed
- [OpenCode](https://opencode.ai) with plugin support
- A running Claude-Mem worker (default `127.0.0.1:37777`)

### Step 1: Install Claude-Mem

In Claude Code:

```text
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Restart Claude Code so the worker can start and initialize its data directory.

### Step 2: Add the OpenCode Plugin

Add this plugin to your project or global `opencode.json`:

**OpenCode 1** (`opencode`):

```json
{
  "plugin": ["@ephemushroom/opencode-claude-mem"]
}
```

**OpenCode 2** (`opencode2`):

```json
{
  "plugins": ["@ephemushroom/opencode-claude-mem/v2"]
}
```

The two runtimes can be installed side by side and load their own entrypoint —
V1 plugins do not load in V2 and vice versa.

Then restart OpenCode.

### Step 3: Verify

```bash
curl -s http://127.0.0.1:37777/api/health
```

If the worker is healthy, the sidebar shows `▶ Memory (online, … obs)`.
OpenCode 1 also shows a `Memory active · <project>` toast when a session
starts (OpenCode 2 only toasts a warning when the worker is offline).

## Using with oh-my-openagent: Disable the Claude Code Bridge

oh-my-openagent ships a Claude Code compatibility layer that can load Claude
Code plugins — including `claude-mem@thedotmack` — inside OpenCode. Running
that bridge **and** this native plugin at the same time means two integrations
write to the same worker:

- duplicate observations for every tool call
- duplicate context injection and toasts
- bridged MCP tools (`search`, `timeline`, `get_observations`) shadowing the
  native `mem-*` tools

Disable the bridge for claude-mem in `~/.config/opencode/oh-my-openagent.jsonc`:

```jsonc
{
  "claude_code": {
    "plugins_override": {
      "claude-mem@thedotmack": false
    }
  }
}
```

This only disables the *bridged* claude-mem inside OpenCode. Claude Code
itself keeps using claude-mem normally, and memory stays shared through the
worker. Everything the bridge provided is covered natively by this plugin:

| Bridged (before) | Native (this plugin) |
|---|---|
| MCP `search` | `mem-search` tool |
| MCP `timeline` | `mem-timeline` tool |
| MCP `get_observations` | `mem-get-observations` tool |
| `SessionStart` context hook | `system.transform` injection |
| `PostToolUse` observation hook | `tool.execute.after` capture |

## Reference

### Hook Mapping

Claude Code hooks → this plugin's adapters (see [Hook Mapping (V1 ↔ V2)](#hook-mapping-v1--v2)
for the per-runtime API):

| Claude Code | OpenCode (both runtimes) | Purpose |
|---|---|---|
| `SessionStart` | system prompt injection (`system.transform` / `context` hook) | Inject memory context |
| `SessionStart` | compaction injection (`session.compacting` / context hook) | Preserve memory during compaction |
| `UserPromptSubmit` | session init (`chat.message` / context hook) | Initialize session with real user prompt |
| `PostToolUse` | observation capture (`tool.execute.after` / `execute.after` hook) | Capture tool observations |
| Claude-Mem MCP `search` | `mem-search` tool | Search memory from OpenCode |
| Claude-Mem MCP `timeline` | `mem-timeline` tool | Chronological context around an observation |
| Claude-Mem MCP `get_observations` | `mem-get-observations` tool | Fetch full observation details by ID |
| _(streaming)_ | assistant text (`message.updated` / `session.text.ended`) | Capture assistant text |
| _(streaming)_ | file edits (`file.edited` / tool hook) | Record file edit observations |
| _(compaction)_ | `session.compacted` / `session.compaction.ended` | Summarize after OpenCode compacts |
| `Stop` | `session.idle` / `session.execution.succeeded` | Flush + summarize |
| `SessionEnd` | `session.deleted` | Flush + complete (no zombie active rows) |

### Worker API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/context/inject?project={name}` | Fetch formatted memory context |
| `POST` | `/api/sessions/init` | Initialize session |
| `POST` | `/api/sessions/observations` | Store tool observation |
| `POST` | `/api/sessions/summarize` | Trigger summarization |
| `POST` | `/api/sessions/complete` | Complete session |
| `GET` | `/api/search?query=...&project=...&dateStart=...&dateEnd=...` | `mem-search`; also supports `limit`, `platformSource`, `type`, `obs_type`, `offset`, and `orderBy` |
| `GET` | `/api/timeline?project={name}&anchor={id}` | `mem-timeline` |
| `POST` | `/api/observations/batch` | `mem-get-observations` |
| `GET` | `/api/stats` + `/api/processing-status` | Sidebar status |
| `GET` | `/api/summaries` + `/api/observations` | Sidebar recent items (expanded only) |

The worker endpoint is resolved in this order: `CLAUDE_MEM_WORKER_HOST` /
`CLAUDE_MEM_WORKER_PORT` environment variables → `~/.claude-mem/settings.json`
→ `127.0.0.1:37777`.

### Key Implementation Details

- **Dual-runtime architecture** — `src/index.ts` is the OpenCode 1 plugin,
  `src/v2.ts` the OpenCode 2 plugin (`Plugin.define`), `src/tui.ts` the V1
  sidebar, `src/cli.ts` the V2 sidebar; `src/shared.ts` and
  `src/sidebar-model.ts` hold the shared pure helpers; `src/worker-client.ts`
  is a static HTTP client; `src/tui-registration.ts` self-heals `tui.json`
  (V1) and `cli.json` (V2).
- **Zero runtime dependencies for server plugins** — the OpenCode plugin SDK
  is bundled into `dist/` (V1 `index.js` ~480 KB, V2 `v2.js` ~30 KB via a deep
  `@opencode-ai/plugin` import that skips effect). The TUI entrypoints keep
  `@opentui/solid` external (provided by the host TUI).
- **Reactive sidebar** — collapse state and view data are solid-js signals
  (shared with OpenCode's own solid instance via `--external solid-js`), so
  clicking the header re-renders reliably; falls back to plain closures if
  solid-js cannot be resolved.
- **No console logging** — `console.*` output corrupts the OpenCode TUI;
  the plugin never logs and never throws from hooks.
- **Deferred toast** — health toasts only happen after hook execution begins,
  avoiding startup crashes caused by early TUI access.
- **Auto-start** — if the worker is down on load, spawns
  `bunx claude-mem start` once per OpenCode process (skipped if `bun` is not
  on `PATH`).
- **Context caching** — memory context is fetched once per session and reused
  across prompt injection and compaction.
- **Circular memory protection** — injected context is wrapped in
  `<claude-mem-context>` tags, Claude-Mem search tools are skipped from
  observation capture, and memory tags are stripped before storage.
- **Observation hardening** — low-value meta tools skipped; oversized payloads
  truncated by UTF-8 byte size (24 KB cap).
- **Field name correctness** — worker payloads use `contentSessionId`, not
  `claudeSessionId` (the wrong name fails silently).
- **Session lifecycle hygiene** — `session.deleted` triggers
  `completeSession`, preventing zombie `active` rows from accumulating stale
  `pending_messages`.

## Troubleshooting

### No memory appears in OpenCode

- Confirm the worker is running:

```bash
curl -s http://127.0.0.1:37777/api/health
```

- Make sure Claude-Mem has already been installed and used from Claude Code.
- Start a fresh OpenCode session after the worker is healthy.

### OpenCode shows `Worker offline`

The plugin tries to launch the worker via `bunx claude-mem start` once on
plugin load. If the toast still appears:

- Confirm `bun` is on your `PATH` — `bun --version` should print a version.
- Confirm `claude-mem` is installed for `bunx` — run
  `bunx claude-mem --version` once to populate the cache.
- On Windows after a forced kill, port `37777` may stay in `TIME_WAIT` for
  30-120 seconds; wait it out or restart Claude Code.
- Restart Claude Code to bring Claude-Mem back up via its own supervisor.

### Sidebar Memory section is missing

- **OpenCode 1**: check `~/.config/opencode/tui.json` contains this plugin in
  its `plugin` array — the plugin self-heals this file on load, so restarting
  OpenCode twice (once to heal, once to load) fixes a missing entry.
- **OpenCode 2**: check `~/.config/opencode/cli.json` contains
  `@ephemushroom/opencode-claude-mem/cli` in its `plugins` array — self-healed
  the same way (comment-bearing cli.json files are left untouched, so remove
  the comments or add the entry manually).
- The sidebar requires OpenCode's `@opentui/solid` runtime; if unavailable the
  section is skipped silently while hooks and tools keep working.

### Clicking the Memory header does nothing

- Upgrade to ≥ 0.4.2 — earlier versions used non-reactive state and the
  toggle never re-rendered.

### Duplicate observations / duplicate toasts

- You are likely running both this plugin and a Claude Code compatibility
  bridge for claude-mem. See
  [Disable the Claude Code bridge](#using-with-oh-my-openagent-disable-the-claude-code-bridge).

### Observations are missing or incomplete

- Low-value meta tools and Claude-Mem search tools are skipped by design.
- Very large tool outputs are truncated before storage (24 KB).

## Development

```bash
bun install
bun run build       # bundle dist/{index,v2,tui,cli}.js + emit declarations
bun test            # bun's built-in runner
bun run lint        # oxlint
bun run fmt:check   # oxfmt
```

If you edit source code locally, rebuild and restart OpenCode to pick up the
new plugin bundle.

## License

MIT
