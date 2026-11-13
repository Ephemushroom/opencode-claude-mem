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

From **v0.7.0** this package is sidebar only. Memory capture, context injection, search
and the MCP tools come from the **official claude-mem OpenCode plugin**, which tracks the
Worker's API in the same release. Earlier versions shipped their own capture adapter; it is
removed so the two can never run side by side.

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

Tested with OpenCode **2.2.7** (`@opencode/plugin` 2.2.7, `@opentui/solid` 0.8.1). The V1
sidebar contract is kept on the same `./tui` export.

## Setup (OpenCode 2)

1. **Install Claude-Mem** in Claude Code and make sure the Worker is healthy:

   ```bash
   curl -s http://127.0.0.1:37777/api/health
   ```

2. **Install the official server plugin.** OpenCode 2 auto-loads single files from
   `~/.config/opencode/plugins/`; the file ships in the `claude-mem` npm package:

   ```bash
   mkdir -p ~/.config/opencode/plugins
   cd "$(mktemp -d)" && npm pack claude-mem@latest --silent \
     && tar -xzf claude-mem-*.tgz package/dist/opencode-plugin/index.js \
     && cp package/dist/opencode-plugin/index.js ~/.config/opencode/plugins/claude-mem.js
   ```

   Claude-Mem's auto-update upgrades the Worker, not this copy: repeat this step after a
   Worker upgrade.

3. **Register the MCP server** (search, timeline, observations, `save_memory`,
   `work_state_*`) in `~/.config/opencode/opencode.json`, under V2's `mcp.servers`:

   ```json
   {
     "mcp": {
       "servers": {
         "claude-mem": {
           "type": "local",
           "command": [
             "/opt/homebrew/bin/node",
             "/Users/<you>/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs"
           ]
         }
       }
     }
   }
   ```

   Point at the marketplace path, not a versioned `plugins/cache/.../<version>/` path, so
   Worker upgrades keep it valid. Prefer this over `npx claude-mem install --ide=opencode`,
   which writes the V1 `mcp` shape.

4. **Add the sidebar** to `~/.config/opencode/cli.json`:

   ```json
   { "plugins": ["@ephemushroom/opencode-claude-mem"] }
   ```

5. **Remove this package from `opencode.json` `plugins`** if an older version put it there.
   Both server plugins use the id `claude-mem`; keeping both captures every tool twice.

### Share memory across Claude Code and OpenCode

The official plugin injects only OpenCode-recorded memory by default. To see every source,
add this to `~/.claude-mem/settings.json` (it also applies to Claude Code's session start):

```json
{ "CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES": "true" }
```

### Verify

```bash
opencode plugin list   # claude-mem  local  ~/.config/opencode/plugins/claude-mem.js
opencode mcp list      # ✓ claude-mem connected
```

Open a session: the sidebar shows `▶ Memory (online, …)`, and new observations carry
canonical tool names (`Read`, `Edit`, `Bash`) with `files_modified` filled in.

## Migrating from v0.6.x

v0.6.x registered `@ephemushroom/opencode-claude-mem` as a **server** plugin. Its capture,
`mem-*` tools, file-history enrichment and semantic injection are gone:

| v0.6.x | Now |
|---|---|
| `mem-search` / `mem-timeline` / `mem-get-observations` | `claude_mem_search` / `claude_mem_timeline` / `claude_mem_get_observations` (official plugin) and the MCP `search` / `timeline` / `get_observations` |
| `mem-save` | MCP `save_memory` |
| Read-file history appended to `read` output | Not available |
| Opt-in semantic injection | Not available |

Follow steps 2–5 above, then keep the bare name in `cli.json` (and `tui.json` for V1).

## Troubleshooting

- **`(offline)`**: the Worker is not running. Start Claude Code, or `bunx claude-mem start`.
- **Sidebar missing**: check `~/.config/opencode/cli.json` lists the package; the sidebar
  needs OpenCode's `@opentui/solid` runtime and is skipped silently without it.
- **Duplicate observations**: two capture integrations are active. Remove this package from
  `opencode.json` `plugins`, and disable any Claude Code compatibility bridge for claude-mem.
- **MCP not listed in an open session**: run `/reload`; already-open locations may keep the
  previous MCP set until they reload.

## Development

```bash
bun install
bun run build          # sidebar adapters + TUI bridge + declarations
bun test               # build first: export tests import dist artifacts
bun run typecheck && bun run lint && bun run fmt:check
bun src/test-fixtures/tui-runtime.ts           # installed opencode: real PTY, render + mouse toggle
bun src/test-fixtures/tui-runtime.ts offline   # offline state renders and toggles
bun --conditions=browser src/test-fixtures/cli-driver.ts render   # OpenTUI component driver
```

The PTY check packs the current build, serves it from a temporary local registry, and runs
the installed `opencode` in an isolated home with a fake Worker. It never touches your config
or memory database and never calls a model. Set `MEM_TUI_EVIDENCE_DIR` to keep the captured
collapsed, expanded, detail-dialog and re-collapsed frames.

## License

MIT
