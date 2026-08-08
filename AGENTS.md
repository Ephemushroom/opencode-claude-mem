# AGENTS.md — opencode-claude-mem

OpenCode plugin for Claude-Mem persistent memory system. Thin HTTP client that
bridges OpenCode hooks to the Claude-Mem worker service.

## Project Overview

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Package manager**: Bun (`bun install`, lockfile: `bun.lock`)
- **Entry points**:
  - `src/index.ts` — OpenCode **V1** plugin (default export `{ server }`)
  - `src/v2.ts` — OpenCode **V2** plugin (`Plugin.define` via `@opencode-ai/plugin-v2/promise/plugin`)
  - `src/tui.ts` — OpenCode **V1** TUI plugin (Memory sidebar, `{ id, tui }`)
  - `src/cli.ts` — OpenCode **V2** TUI plugin (Memory sidebar, `Plugin.define` via `@opencode-ai/plugin-v2/tui/plugin`)
  - `src/worker-client.ts` — HTTP client (shared by all entrypoints)
  - `src/sidebar-model.ts` — pure sidebar view model shared by both TUI entrypoints
  - `src/shared.ts` — pure helpers shared by the server entrypoints
- **Output**: `dist/` (compiled JS + declarations)
- **CI**: GitHub Actions (`.github/workflows/ci.yml`, `.github/workflows/release.yml`)

## Build / Lint / Test Commands

```bash
# Install dependencies
bun install

# Build (type-check + emit)
bun run build          # runs: tsc

# Dev mode (watch)
bun run dev            # runs: tsc --watch

# Lint (code quality)
bun run lint           # runs: oxlint

# Format (code style)
bun run fmt            # runs: oxfmt --write src/
bun run fmt:check      # runs: oxfmt --check src/ (CI dry-run)

# CI install (frozen lockfile)
bun install --frozen-lockfile
```

Verification: `tsc` build succeeds, `oxlint` reports 0 errors, `oxfmt --check` passes.

If you add tests, use `bun test` (Bun's built-in test runner). Place test files
alongside source as `*.test.ts` or in a `__tests__/` directory.

## TypeScript Configuration

- **Target**: ESNext
- **Module**: ESNext with `bundler` module resolution
- **Strict**: `true` (all strict checks enabled)
- **Types**: `bun-types` (Bun runtime globals)
- **Declaration**: `true` (emits `.d.ts` files)
- **Output**: `dist/`
- **Include**: `src/**/*`

## Code Style Guidelines

### Formatting

- Semicolons: none (enforced by oxfmt)
- Quotes: single quotes (`'...'`)
- Indentation: 2 spaces
- Trailing commas: ES5 style (arrays/objects yes, function params no)
- Line length: 100 chars (enforced by oxfmt `printWidth`)
- Braces: same-line opening brace (K&R style)
- Curly braces: always required for `if`/`else`/`for`/`while` blocks (enforced by oxlint `curly`)
- Bracket spacing: `{ foo }` not `{foo}` (enforced by oxfmt)

### Imports

- Named imports only — no default exports in this codebase
- Relative imports without file extensions: `import { WorkerClient } from './worker-client'`
- External imports: `import { type Plugin, tool } from '@opencode-ai/plugin'`
- Use `import type` or inline `type` keyword for type-only imports

### Naming Conventions

- **Classes**: PascalCase (`WorkerClient`)
- **Methods/functions**: camelCase (`ensureSessionInit`, `extractTextFromParts`)
- **Variables/params**: camelCase (`projectName`, `contentSessionId`)
- **Constants**: camelCase or UPPER_SNAKE for true constants (`CONTEXT_CACHE_TTL`)
- **Types/Interfaces**: PascalCase (`Plugin`)

### Class Pattern

`WorkerClient` uses all-static methods — no instantiation. This is the established
pattern for service clients in this codebase. Follow it for new service classes.

```typescript
export class ServiceClient {
  private static readonly BASE_URL = getWorkerBaseUrl()

  static async methodName(): Promise<ReturnType> {
    // ...
  }
}
```

### Error Handling

This plugin follows a "never throw, never log" pattern:

- **All HTTP calls** are wrapped in try/catch
- **Catch blocks** either return a fallback (`null`, `false`, empty string) or silently swallow
- **Never use `console.log`, `console.warn`, or `console.error`** — output corrupts the OpenCode TUI
- Use `toast()` helper for user-visible status messages (best-effort, never throws)
- Abort controllers with timeouts for health checks

```typescript
// Correct pattern
try {
  const response = await fetch(url)
  if (!response.ok) {
    return null
  }
  return await response.json()
} catch {
  return null
}

// WRONG — never do this
console.error('Failed:', error)  // corrupts TUI
throw error                       // breaks OpenCode
```

### Type Safety

- `strict: true` is enabled — respect it
- Avoid `as any` except when interfacing with untyped SDK APIs (e.g., `client.tui`)
- Use explicit return types on public/exported methods
- Use `any` for SDK callback parameters that lack proper types (e.g., hook `event` param)
- Prefer `unknown` over `any` when the type will be narrowed

### Plugin Architecture

Two entrypoints exist — one per OpenCode runtime (they are API-incompatible):

**V1 (`src/index.ts`)** — exports a single async factory function
(`ClaudeMemPlugin`) that:
1. Receives context (`project`, `directory`, `client`)
2. Sets up internal state (session tracking, caches)
3. Returns an object of hook handlers

V1 hook handlers:
- `event` — session lifecycle (`session.created`, `session.idle`)
- `chat.message` — session init with real user prompt
- `experimental.chat.system.transform` — inject memory into system prompt
- `tool.execute.after` — capture tool observations
- `tool` — custom tool definitions (`mem-search`)

**V2 (`src/v2.ts`)** — `Plugin.define({ id: 'claude-mem', setup })` via
`@opencode-ai/plugin-v2/promise/plugin` (deep import — the root entry pulls in
effect/schema, the deep path bundles to ~28 KB). Setup registers:
- `ctx.session.hook('context')` — init session with real user prompt (from
  `event.messages`) + push `<claude-mem-context>` SystemPart into `event.system`
- `ctx.tool.hook('execute.after')` — capture tool observations (`event.result`
  on `status: 'completed'`, `event.error` on `'error'`)
- `ctx.tool.transform((tools) => tools.add(...))` — the `mem-*` tools with
  `options: { codemode: false }` (exposed directly to the provider)
- `ctx.event.subscribe()` — detached async loop (never awaited in setup, retried
  on disconnect after `EVENT_RETRY_DELAY_MS`); assistant text comes from
  `session.text.ended` (complete text, no debounce needed), summarization on
  `session.execution.succeeded` / `session.compaction.ended`, completion on
  `session.deleted`

V2 has no `client.tui` — there is no toast API; skip toasts entirely.

**V2 TUI (`src/cli.ts`)** — `Plugin.define({ id: 'claude-mem.tui', setup })`
via `@opencode-ai/plugin-v2/tui/plugin`. Loaded from `~/.config/opencode/cli.json`
`plugins` array as `@ephemushroom/opencode-claude-mem/cli`. Renders the
Memory sidebar into the `sidebar.content` slot:
- Element model: imperative `@opentui/solid` `createElement`/`setProp`/`insert`
  (same as V1), dynamic-imported at setup with a graceful null fallback
- State: `ctx.storage.memory('claude-mem.sidebar', ...)` — solid Store read
  inside the slot render so mutations re-render reactively
- Poll: 5s interval via `readMemView` (shared model); immediate refresh on
  `session.created` / `session.execution.succeeded` via `ctx.data.on`
- One-time offline warning toast via `ctx.ui.toast.show`
- Setup returns a cleanup (timer, slot disposer, event disposers)
- `@opentui/solid` is a real runtime `dependency` (OpenCode installs plugin
  deps into an isolated cache) but is also dynamic-imported defensively

Both entrypoints share `WorkerClient` and pure helpers in `src/shared.ts`
(sanitization, truncation, skip lists, text extraction). V2 state is keyed per
session (`sessionDirs`, `contextCache`, `sessionUserTexts`,
`sessionAssistantTexts` maps) because the V2 server hosts multiple sessions.
The sidebar view model (stats + rows) lives in `src/sidebar-model.ts`, shared
by `tui.ts` (V1) and `cli.ts` (V2); themes map V2 `ResolvedTheme` RGBA
tokens onto the model's `Theme` interface.

### Critical Implementation Details

- **Field name**: Worker API uses `contentSessionId` (NOT `claudeSessionId`) — wrong name causes silent failures
- **Platform source**: Worker write payloads include `platformSource: "opencode"` for attribution
- **Worker endpoint**: Resolve host/port from env, then `~/.claude-mem/settings.json`, then `127.0.0.1:37777`
- **Deferred toast**: Never call `client.tui.showToast()` during plugin init — TUI isn't ready, crashes OpenCode
- **Idempotent init**: `ensureSessionInit()` tracks initialized sessions in a `Set` — safe to call repeatedly
- **Context caching**: `getCachedContext()` fetches context once per OpenCode session and resets on `session.created`
- **Search tool**: `mem-search` forwards the worker search contract (`query`, `limit`, `project`, `platformSource`, `type`, `obs_type`, `dateStart`, `dateEnd`, `offset`, `orderBy`) and is skipped by observation capture
- **MCP boundary**: Claude Code plugin MCP is not automatically available in OpenCode; configure MCP separately if `timeline`/`get_observations` are needed

## Worker API Endpoints

Calls go to the resolved Claude-Mem worker endpoint:

| Method | Endpoint                          | Purpose                    |
|--------|-----------------------------------|----------------------------|
| GET    | `/api/health`                     | Health check               |
| GET    | `/api/context/inject?project=...` | Get formatted context      |
| POST   | `/api/sessions/init`              | Initialize session         |
| POST   | `/api/sessions/observations`      | Send tool observation      |
| POST   | `/api/sessions/summarize`         | Trigger summarization      |
| POST   | `/api/sessions/complete`          | Complete session           |
| GET    | `/api/search?query=...&project=...&dateStart=...&dateEnd=...` | Search memory with full filters |

## File Structure

```
src/
  index.ts          — OpenCode V1 plugin entry: hooks, toast, session management
  v2.ts             — OpenCode V2 plugin entry: Plugin.define setup + event loop
  tui.ts            — OpenCode V1 TUI plugin (Memory sidebar, { id, tui })
  cli.ts            — OpenCode V2 TUI plugin (Memory sidebar, Plugin.define)
  sidebar-model.ts  — Pure sidebar view model shared by tui.ts and cli.ts
  shared.ts         — Pure helpers shared by the server entrypoints
  worker-client.ts  — Static HTTP client for Claude-Mem worker API
  tui-registration.ts — tui.json (V1) + cli.json (V2) sidebar self-heal
dist/               — Build output (gitignored)
```

## CI/CD

- **CI** (`ci.yml`): Runs on push/PR to `main`. Installs with frozen lockfile, builds, verifies dist output exists.
- **Release** (`release.yml`): Triggered by `v*.*.*` tags. Builds and creates GitHub Release with dist artifacts.

## Common Pitfalls

1. Don't add `console.*` calls — they corrupt the OpenCode TUI
2. Don't call TUI methods during plugin initialization — defer to first hook invocation
3. Always use `contentSessionId` in worker API payloads, never `claudeSessionId`
4. The plugin is loaded as a single JS file via symlink — keep the dependency footprint minimal
5. Worker must be running (via Claude Code) before the plugin can function
6. **Windows `nul` file**: If you see a `nul` file in the project root, delete it (`rm nul`). Do not commit it. It is already in `.gitignore`.
