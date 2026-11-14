# opencode-claude-mem

The **Memory sidebar** for [OpenCode](https://opencode.ai), backed by
[Claude-Mem](https://github.com/thedotmack/claude-mem).

```text
▶ Memory (online, 549 obs)            ← collapsed (default): this project's observations

▼ Memory opencode-claude-mem          ← click the header to expand
  • obs 549 · sum 51 · ses 13
  • all 54.0k obs                     ← every project, muted
  Recent sessions
  • 发布 0.7.0 前核查与侧边栏项目统计…
    12m ago
  Latest
  ◆ TUI 动态坐标重算修复后连续 4 次…
    3m ago · #55670
  Click an item for details           ← opens the full summary or observation
```

One package brings claude-mem to OpenCode 2, installed and updated like any other plugin:

- **Capture and context injection** run the **official claude-mem OpenCode plugin**. This
  package downloads it at the running Worker's version (from the `claude-mem` npm release,
  checked against the registry's sha512) and loads it, so capture always matches the
  Worker's API and no file has to be copied by hand.
- **Memory tools** beyond the official plugin's search: `save_memory`, `work_state_write`,
  `work_state_read`, `dumb_search`, `get_tool_uses` and the six corpus tools, served straight
  from the Worker's HTTP API. No MCP server is needed.
- **The Worker is started** when nothing answers on its port.
- **The Memory sidebar**, below.

- Counts are for the current project (the directory name), matching the Worker's own
  project filter: case-insensitive, merged projects included. They are read from the Worker's
  database in read-only mode, because its HTTP API reports only global totals. When the
  database is not on this machine or cannot be read, the sidebar shows global totals and
  labels them `all ·`.
- Titles are truncated by display width with an ellipsis, so wide CJK text fits; the
  project's own name is dropped from titles, since every row belongs to it.
- Clicking a recent session or observation opens its details in a dialog; observations show
  the `get_observations([id])` call that fetches them through MCP.
- Summary turns yellow while the Worker is processing (`(queue N)`) and red when offline.
- Icons follow the injected context legend: ◆ feature · ● bugfix · ⚖ decision ·
  ○ discovery · ↻ refactor · ✓ change · ⚠/⚷ security.
- Recent rows are fetched only while expanded; collapsed, it polls stats every 5s.
- Read-only and fail-open: an offline Worker shows the offline state, never blocks the TUI.

Verified on macOS with OpenCode **2.3.0** (built against `@opencode/plugin` 2.2.7,
`@opentui/solid` 0.8.1). The Windows paths follow claude-mem's own launcher location but
have not been run on Windows yet.

## Setup (OpenCode 2)

1. **Install claude-mem** once per machine. This installs the Worker and its launcher:

   ```bash
   npx claude-mem install
   ```

2. **Add the plugin.** This installs the package and lists it in
   `~/.config/opencode/opencode.json`:

   ```bash
   opencode plugin add @ephemushroom/opencode-claude-mem
   ```

3. **Add the sidebar** to `~/.config/opencode/cli.json`:

   ```json
   { "plugins": ["@ephemushroom/opencode-claude-mem"] }
   ```

Restart OpenCode. The first start downloads the official files (about 10 MB) in the
background; the memory tools work at once, and capture begins when the download finishes.

### Updating

```bash
opencode plugin update     # this package: server part and sidebar
```

OpenCode does not update plugins by itself. The official claude-mem files need no command:
after a Worker upgrade, the next OpenCode start fetches the matching version.

### Options

```json
{
  "plugins": [{ "package": "@ephemushroom/opencode-claude-mem", "options": { "mcp": true } }]
}
```

- `mcp: true` registers claude-mem's own MCP server (every tool it has, including the
  `smart_*` code-outline tools) in a separate process, instead of this package's tools.
  A `claude-mem` entry you wrote under `mcp.servers` is left as it is.

claude-mem's settings apply as usual (its `settings.json`, in `~/.claude-mem` or
`CLAUDE_MEM_DATA_DIR`, or the environment):

- `CLAUDE_MEM_WORKER_HOST` / `CLAUDE_MEM_WORKER_PORT` select the Worker. Without a port,
  claude-mem's own default applies (37700 plus the last two digits of the user id).
- `CLAUDE_MEM_LOCAL_API_TOKEN` is sent to a Worker on this machine that requires it. This
  package's own requests refuse redirects; the official plugin's capture requests are
  claude-mem's code and follow them (as of 15.18.3).
- `CLAUDE_MEM_WORKER_AUTOSTART=false` keeps this package from starting the Worker.
- `CLAUDE_MEM_WORK_STATE_ENABLED=false` removes the two work-state tools.
- `CLAUDE_MEM_WORKER_URL` is not supported: the official OpenCode plugin addresses the
  Worker by host and port only, so the sidebar reports it and nothing is captured.

### Tools

OpenCode lists them as the `claude_mem` namespace (`tools.claude_mem.save_memory(...)` in
Code Mode, `claude_mem_save_memory` as a direct tool call). The official plugin adds
`claude_mem_search`, `claude_mem_timeline` and `claude_mem_get_observations`.

| Tool | Purpose |
|---|---|
| `save_memory` | Save a durable note |
| `work_state_write` / `work_state_read` | Per-project to-do lists and working state, shown at session start |
| `dumb_search` | One-call lookup by title overlap |
| `get_tool_uses` | Raw tool input/output for selected ids |
| `build_corpus`, `list_corpora`, `prime_corpus`, `query_corpus`, `rebuild_corpus`, `reprime_corpus` | Knowledge corpora |

### Share memory across Claude Code and OpenCode

The official plugin injects only OpenCode-recorded memory by default. To see every source,
add this to `~/.claude-mem/settings.json` (it also applies to Claude Code's session start):

```json
{ "CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES": "true" }
```

### Verify

```bash
opencode plugin list   # opencode-claude-mem  0.7.1  @ephemushroom/opencode-claude-mem
```

Open a session: the sidebar shows `▶ Memory (online, …)`, and new observations carry
canonical tool names (`Read`, `Edit`, `Bash`) with `files_modified` filled in.

### Where files go

`~/.cache/opencode-claude-mem/` (or `$XDG_CACHE_HOME/opencode-claude-mem/`): the official
files under `official/<version>/` (about 1.5 MB per claude-mem version; earlier versions are
kept, because another OpenCode process may still run from them) and `status/`, which carries
the server part's state to the sidebar. Deleting the directory while OpenCode is closed is
safe.

## Migrating

**From v0.7.0's manual setup.** Remove what the manual steps installed, then follow Setup:

- delete `~/.config/opencode/plugins/claude-mem.js`. While that file exists it keeps
  capturing, this package does not load a second copy, and that file is not kept up to date;
- delete the `claude-mem` entry under `mcp.servers` in `opencode.json`, unless you want
  the MCP server; in that case use `options.mcp` instead.

**From v0.6.x.** Its own capture adapter is gone; capture is the official plugin's.
`mem-search` / `mem-timeline` / `mem-get-observations` are now `claude_mem_search` /
`claude_mem_timeline` / `claude_mem_get_observations`, and `mem-save` is `save_memory`.
Read-file history and opt-in semantic injection are not available.

**OpenCode 1.** The server part needs OpenCode 2. On OpenCode 1 use
`npx claude-mem install --ide opencode`; the sidebar still loads from `tui.json`.

## Troubleshooting

- **`(offline)`**: the Worker is not running and could not be started. Run
  `npx claude-mem start`; if that command is missing, `npx claude-mem install`.
- **`(capture off)`**: nothing records this OpenCode's sessions. Expand the sidebar: the
  first row says why (claude-mem not installed, the Worker did not start, the download
  failed, or a `plugins/claude-mem.js` file that OpenCode has not loaded) and what to do.
  The package looks again every minute.
- **Sidebar missing**: check `~/.config/opencode/cli.json` lists the package; the sidebar
  needs OpenCode's `@opentui/solid` runtime and is skipped silently without it.
- **Duplicate observations**: two capture integrations are active. Remove
  `~/.config/opencode/plugins/claude-mem.js` or this package, and disable any Claude Code
  compatibility bridge for claude-mem. In Code Mode one call is recorded as `execute` plus
  the tool it ran; that is one call, not a duplicate.
- **Behind a registry mirror**: the download uses `CLAUDE_MEM_NPM_REGISTRY`, then
  `npm_config_registry`, then `https://registry.npmjs.org`. The mirror must be HTTPS (or on
  this machine): it names both the tarball and its checksum, so it is trusted like the
  registry itself.

## Development

```bash
bun install
bun run build          # server part + sidebar adapters + TUI bridge + declarations
bun test               # build first: export tests import dist artifacts
bun run typecheck && bun run lint && bun run fmt:check
bun src/test-fixtures/server-runtime.ts        # installed opencode: download, capture, tools
bun src/test-fixtures/server-runtime.ts mcp    # options.mcp registers the MCP server
bun src/test-fixtures/server-runtime.ts start  # no Worker: the launcher is run (macOS/Linux)
bun src/test-fixtures/server-runtime.ts standalone  # plugins/claude-mem.js present: one capture
bun src/test-fixtures/tui-runtime.ts           # installed opencode: real PTY, render + mouse toggle
bun src/test-fixtures/tui-runtime.ts offline   # offline state renders and toggles
bun --conditions=browser src/test-fixtures/cli-driver.ts render   # OpenTUI component driver
```

The runtime checks pack the current build, serve it from a temporary local registry, and run
the installed `opencode` in an isolated home with a fake Worker and model. They never touch
your config or memory database. The server check downloads the real `claude-mem` release. Set `MEM_TUI_EVIDENCE_DIR` to keep the captured
collapsed, expanded, detail-dialog and re-collapsed frames.

## License

MIT
