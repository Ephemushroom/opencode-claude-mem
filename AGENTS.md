# AGENTS.md — opencode-claude-mem

Claude-Mem for OpenCode 2 in one package: a **server part** and the **Memory sidebar**.

The server part carries no capture code of its own. It downloads the official claude-mem
OpenCode plugin (`claude-mem/dist/opencode-plugin/index.js`) at the running Worker's version
and runs its `setup` with this plugin's context, so capture and context injection always
match the Worker's API. Never reimplement capture here: v0.6.x did, and drifted silently
when the Worker changed. On top of the official plugin it adds memory tools, starts the
Worker and reports its state to the sidebar.

## Project Overview

- **Runtime**: Bun · **Language**: TypeScript (strict) · **Package manager**: Bun (`bun.lock`)
- **SDK**: `@opencode/plugin` / `@opencode/theme` pinned to the installed OpenCode release
  (currently `2.2.7`); `@opentui/solid` and `@opentui/core` match its peer range (`0.8.1`).
- **Entry points**:
  - `src/server.ts` — OpenCode **V2** server plugin at `./server` (id `opencode-claude-mem`)
  - `src/official-sync.ts` — downloads and verifies the official plugin and MCP server
  - `src/worker-tools.ts` — memory tools served from the Worker's HTTP API
  - `src/worker-start.ts` — starts the Worker through claude-mem's launcher
  - `src/capture-status.ts` — per-checkout status file from the server part to the sidebar
  - `src/package-tui.ts` — static V1/V2 sidebar bridge at `./tui`
  - `src/tui.ts` — OpenCode **V1** sidebar (`{ id, tui }`)
  - `src/cli.ts` — OpenCode **V2** sidebar (`Plugin.define` via `@opencode/plugin/tui`), also `./cli`
  - `src/sidebar-model.ts` — pure view model shared by both sidebars
  - `src/worker-client.ts` — read-only Worker client for the sidebar, and settings/endpoint parsing
- **Output**: `dist/` · **CI**: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

## Commands

```bash
bun install
bun run build        # bundle server/tui/cli, emit the TUI bridge, emit declarations
bun test             # build first: export tests load dist artifacts
bun run typecheck
bun run lint         # oxlint, 0 errors required
bun run fmt:check    # oxfmt
bun src/test-fixtures/server-runtime.ts       # installed `opencode`: download, capture, tools
bun src/test-fixtures/server-runtime.ts mcp   # options.mcp registers claude-mem's MCP server
bun src/test-fixtures/server-runtime.ts start # no Worker: the launcher is run (macOS/Linux)
bun src/test-fixtures/server-runtime.ts standalone # plugins/claude-mem.js present: one capture
bun src/test-fixtures/tui-runtime.ts          # installed `opencode`: real PTY render + mouse toggle
bun src/test-fixtures/tui-runtime.ts offline  # offline state renders and toggles
```

## Code Style

- oxfmt: no semicolons, single quotes, 2 spaces, ES5 trailing commas, 100 columns.
- oxlint `curly`: braces on every `if`/`else`/`for`/`while` body.
- Relative imports without extensions; `import type` for type-only imports.
- `WorkerClient` is all-static; follow that pattern for service clients.

### Error handling: never throw, never log

- Every Worker call is wrapped in try/catch and returns a fallback (`null`, `[]`).
- Write no `console.*`: output corrupts the OpenCode TUI. User-visible status goes through
  `ctx.ui.toast.show` (V2), once, after the first refresh.
- The server part never throws out of `setup`: the host would drop its tools and only log a
  warning. Failures go to that setup's status file
  (`<cache>/status/<checkout-hash>.<pid>.<id>.json`, removed on dispose), which the sidebar
  shows as `(capture off)`. One file per `setup`: instances never remove each other's.
- A tool never throws: it returns text saying what went wrong, so the model can react.

## Server Part Architecture

- `setup` registers the tools first, then runs Worker start, download and official-plugin
  load behind a 2s wait. Setup blocks the session's first request, and hooks or tools
  registered after it returns still take effect (verified on OpenCode 2.3.0).
- Only the first pass starts the Worker. After a failure `attemptCapture` runs again every
  minute without launching, so a Worker that crashes on start is not relaunched in a loop.
  A pass does only what is still missing and records a step after it succeeded: calling the
  official `setup` twice for one checkout records everything twice.
- The official plugin is loaded only at exactly the Worker's reported version. Never fall
  back to another cached version: after a Worker upgrade or downgrade it would capture with
  the wrong API for the rest of the process.
- Worker start: probe `/api/health`; only a refused connection means "absent". Then run
  `claude-mem start` (`~/.local/bin/claude-mem`, or `%LOCALAPPDATA%\claude-mem\bin\claude-mem.exe`),
  the command Claude Code's SessionStart hook runs. A Worker that answers is never restarted
  or replaced; honour `CLAUDE_MEM_WORKER_AUTOSTART=false` and `CLAUDE_MEM_WORKER_URL`.
- Official files: `<cache>/official/<version>/{opencode-plugin.mjs,mcp-server.cjs}`, where
  `<cache>` is `$XDG_CACHE_HOME/opencode-claude-mem` or `~/.cache/opencode-claude-mem`. The
  version directory is staged and renamed into place. Versions are never pruned: another
  process, or an MCP server registered earlier, may still run from an older one. The
  registry must be HTTPS (or loopback), since it names the tarball and its digest together.
  The metadata request refuses redirects (it carries the digest); the tarball request may
  be redirected to a CDN. The tarball is read with the built-in tar reader; Windows may
  have no `tar` on PATH.
- The plugin id must not be `claude-mem`: that is the official plugin's id. A standalone
  copy (`claude-mem.js` in the active config directory's `plugins/`, or in `.opencode/plugins/`
  of the checkout or a directory above it) is normally loaded by OpenCode itself, and a
  second copy would record everything twice. The file alone proves nothing, so the host
  decides: `ctx.plugin.list()` reports the `claude-mem` plugin as `active` (yield to it, no
  download needed), `failed` (load this package's copy), or absent while the file exists
  (report a conflict; neither claim capture nor load a copy). The list is empty until every
  plugin's `setup` has returned, so it is polled only when the file exists.
- Worker requests: `worker-client.ts` follows claude-mem's own rules (settings.json in the
  data directory, flat or under `env`, numbers and booleans accepted; default port
  37700 + uid % 100; `localhost` read as `127.0.0.1`; bracketed IPv6) so
  tools, sidebar and the official plugin reach the same Worker. `CLAUDE_MEM_LOCAL_API_TOKEN`
  is sent as `x-claude-mem-token` to a loopback Worker only, and every request uses
  `redirect: 'error'`. `CLAUDE_MEM_WORKER_URL` is refused: the official OpenCode plugin
  cannot target it. The official plugin's own capture requests are upstream code and still
  follow redirects (as of claude-mem 15.18.3).
- Tools live in the `claude_mem` namespace and are named without it (`save_memory`). Code
  Mode lists few tools per namespace, so `save_memory` and the two work-state tools are
  `pinned`. Result text follows claude-mem's `mcp-text-format.ts`; unknown Worker fields
  never reach the model.
- `options.mcp: true` skips the tools and registers claude-mem's MCP server through
  `ctx.mcp.transform`, with Node when present and otherwise the host binary with
  `BUN_BE_BUN=1`. An existing `claude-mem` MCP entry is left alone.
- Not ported on purpose: `smart_search` / `smart_unfold` / `smart_outline` (tree-sitter code
  outline, unrelated to memory), `important_workflow`, `session_start_context`.

## Sidebar Architecture

- `./tui` -> `package-tui.ts`: `{ id, tui: v1.tui, setup: v2.setup }`. V1 rejects an object
  with both `server` and `tui`; V2 requires `id` plus `setup`.
- The emitted bridge must import `./tui.js` and `./cli.js` with explicit extensions
  (`build-tui-bridge.ts`). The host prescans runtime modules; extensionless imports bypass
  its Solid/OpenTUI singletons and cause `No renderer found`.
- V2 (`cli.ts`): imperative `@opentui/solid` elements, dynamic-imported with a null fallback;
  state in `ctx.storage.memory('claude-mem.sidebar')`; slot `{ append: 'sidebar.content' }`
  with children inserted through an accessor (the slot renders once); 5s poll plus refresh on
  `session.created` / `session.execution.succeeded`; setup returns cleanup.
- Worker endpoint: env, then claude-mem's `settings.json`, then `127.0.0.1` and claude-mem's
  default port (see "Worker requests" above).
- Recent rows are fetched only while expanded, keeping the collapsed poll to two requests.

## Worker API Endpoints (read-only)

| Method | Endpoint                                  | Purpose                     |
|--------|-------------------------------------------|-----------------------------|
| GET    | `/api/stats`                              | Counts and worker status    |
| GET    | `/api/processing-status`                  | Queue depth                 |
| GET    | `/api/summaries?project=...&limit=...`    | Recent sessions (expanded)  |
| GET    | `/api/observations?project=...&limit=...` | Latest observations (expanded) |
| GET    | `/api/observation/:id`                    | Observation detail dialog   |
| GET    | `/api/session/:id`                        | Session summary detail dialog |

Used by the server part:

| Method | Endpoint                                  | Purpose                     |
|--------|-------------------------------------------|-----------------------------|
| GET    | `/api/health`                             | Worker presence and version |
| POST   | `/api/memory/save`                        | `save_memory` (strict body: text, title, project, metadata, cwd) |
| POST   | `/api/work-state/entries`                 | `work_state_write` (cwd, list, fields); plain-text reply |
| GET    | `/api/work-state?cwd=...`                 | `work_state_read`; plain-text reply |
| POST   | `/api/dumb-search`                        | `dumb_search`               |
| POST   | `/api/tool-uses/batch`                    | `get_tool_uses`             |
| GET    | `/api/corpus`                             | `list_corpora`              |
| POST   | `/api/corpus`, `/api/corpus/:name/{prime,query,rebuild,reprime}` | Corpus tools; SSE with `Accept: text/event-stream` |

Per-project counts are not in the HTTP API: `WorkerClient.getProjectCounts` opens the
Worker's `claude-mem.db` with `bun:sqlite` `readonly: true` (loopback Worker only) and uses
the Worker's project filter (`COLLATE NOCASE`, plus `merged_into_project`). Any failure
returns null and the sidebar falls back to global `/api/stats`.

## Test Fixture Gotchas

- `tui-runtime.ts` loads no server plugin; it registers the packed package in `cli.json` only.
- `server-runtime.ts` downloads the real `claude-mem` release through the fixture registry.
  Its model script calls this package's tools through Code Mode's `execute`, so one call is
  recorded twice (`execute` and the tool). It sets `PWD`: OpenCode takes the checkout from it.
- Fixtures delete `OPENCODE_SESSION_ID` and `OPENCODE_EXPERIMENTAL_CODE_MODE`, which are
  inherited when they run inside an OpenCode session.
- Bun extracts node-pty's `spawn-helper` without its execute bit; the fixture `chmod`s it,
  otherwise PTY spawn fails with `posix_spawnp failed`.
- OpenCode 2.2.7+ enables any-motion mouse tracking and hit-tests from the pointer, so
  `tui-screen.ts` hovers before clicking and repeats the click until the next state appears.

## Common Pitfalls

1. No `console.*` calls.
2. Ship all of `dist/`: the bridge references the adjacent adapter bundles.
3. The Worker must be installed (`npx claude-mem install`); this package starts it but
   never installs, restarts or upgrades it.
4. **Windows `nul` file**: delete a stray `nul` in the project root; never commit it.
