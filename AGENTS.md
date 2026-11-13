# AGENTS.md — opencode-claude-mem

OpenCode **Memory sidebar** for Claude-Mem. Sidebar only: capture, context injection,
search and MCP belong to the official claude-mem OpenCode plugin
(`claude-mem/dist/opencode-plugin/index.js`). This package must never ship a server part,
because it would compete with the official plugin's `claude-mem` id and capture twice.

## Project Overview

- **Runtime**: Bun · **Language**: TypeScript (strict) · **Package manager**: Bun (`bun.lock`)
- **SDK**: `@opencode/plugin` / `@opencode/theme` pinned to the installed OpenCode release
  (currently `2.2.7`); `@opentui/solid` and `@opentui/core` match its peer range (`0.8.1`).
- **Entry points**:
  - `src/package-tui.ts` — static V1/V2 sidebar bridge at `./tui`
  - `src/tui.ts` — OpenCode **V1** sidebar (`{ id, tui }`)
  - `src/cli.ts` — OpenCode **V2** sidebar (`Plugin.define` via `@opencode/plugin/tui`), also `./cli`
  - `src/sidebar-model.ts` — pure view model shared by both sidebars
  - `src/worker-client.ts` — read-only Worker client (stats, processing status, summaries, observations)
- **Output**: `dist/` · **CI**: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

## Commands

```bash
bun install
bun run build        # bundle tui/cli, emit the TUI bridge, emit declarations
bun test             # build first: export tests load dist artifacts
bun run typecheck
bun run lint         # oxlint, 0 errors required
bun run fmt:check    # oxfmt
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
- Worker endpoint: env, then `~/.claude-mem/settings.json`, then `127.0.0.1:37777`.
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

Per-project counts are not in the HTTP API: `WorkerClient.getProjectCounts` opens the
Worker's `claude-mem.db` with `bun:sqlite` `readonly: true` (loopback Worker only) and uses
the Worker's project filter (`COLLATE NOCASE`, plus `merged_into_project`). Any failure
returns null and the sidebar falls back to global `/api/stats`.

## Test Fixture Gotchas

- `tui-runtime.ts` loads no server plugin; it registers the packed package in `cli.json` only.
- Bun extracts node-pty's `spawn-helper` without its execute bit; the fixture `chmod`s it,
  otherwise PTY spawn fails with `posix_spawnp failed`.
- OpenCode 2.2.7 enables any-motion mouse tracking and hit-tests from the pointer, so
  `tui-screen.ts` hovers before clicking and repeats the click until the next state appears.

## Common Pitfalls

1. No `console.*` calls.
2. Ship all of `dist/`: the bridge references the adjacent adapter bundles.
3. The Worker must already be running; this package never starts it.
4. **Windows `nul` file**: delete a stray `nul` in the project root; never commit it.
