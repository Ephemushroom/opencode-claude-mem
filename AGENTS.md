# AGENTS.md — opencode-claude-mem

OpenCode plugin for Claude-Mem persistent memory system. Thin HTTP client that
bridges OpenCode hooks to the Claude-Mem worker service (port 37777).

## Project Overview

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Package manager**: Bun (`bun install`, lockfile: `bun.lock`)
- **Entry point**: `src/index.ts` (plugin factory), `src/worker-client.ts` (HTTP client)
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
  private static readonly PORT = 37777
  private static readonly BASE_URL = `http://127.0.0.1:${ServiceClient.PORT}`

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

The plugin exports a single async factory function (`ClaudeMemPlugin`) that:
1. Receives context (`project`, `directory`, `client`)
2. Sets up internal state (session tracking, caches)
3. Returns an object of hook handlers

Hook handlers available:
- `event` — session lifecycle (`session.created`, `session.idle`)
- `chat.message` — session init with real user prompt
- `experimental.chat.system.transform` — inject memory into system prompt
- `experimental.chat.messages.transform` — inject visible context block in TUI
- `tool.execute.after` — capture tool observations
- `tool` — custom tool definitions (`mem-search`)

### Critical Implementation Details

- **Field name**: Worker API uses `contentSessionId` (NOT `claudeSessionId`) — wrong name causes silent failures
- **Deferred toast**: Never call `client.tui.showToast()` during plugin init — TUI isn't ready, crashes OpenCode
- **Idempotent init**: `ensureSessionInit()` tracks initialized sessions in a `Set` — safe to call repeatedly
- **Context caching**: `experimental.chat.messages.transform` caches context with 30s TTL to avoid re-fetching on every render
- **Synthetic messages**: The messages transform hook prepends a synthetic assistant message with a unique ID (`claude-mem-context-msg`) and checks for it to prevent duplicates

## Worker API Endpoints

All calls go to `http://127.0.0.1:37777`:

| Method | Endpoint                          | Purpose                    |
|--------|-----------------------------------|----------------------------|
| GET    | `/api/health`                     | Health check               |
| GET    | `/api/context/inject?project=...` | Get formatted context      |
| POST   | `/api/sessions/init`              | Initialize session         |
| POST   | `/api/sessions/observations`      | Send tool observation      |
| POST   | `/api/sessions/summarize`         | Trigger summarization      |
| POST   | `/api/sessions/complete`          | Complete session           |
| GET    | `/api/search?q=...&project=...`   | Search memory              |

## File Structure

```
src/
  index.ts          — Plugin entry: hooks, toast, session management
  worker-client.ts  — Static HTTP client for Claude-Mem worker API
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
