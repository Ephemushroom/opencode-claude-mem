/**
 * Worker Client for Claude-Mem
 * Handles communication with the local worker service running on port 37777.
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const HEALTH_TIMEOUT_MS = 1000
const AUTOSTART_POLL_INTERVAL_MS = 500
const AUTOSTART_POLL_MAX_ATTEMPTS = 16

export type AutoStartResult =
  | 'already-running'
  | 'started'
  | 'no-bun'
  | 'spawn-failed'
  | 'timeout'
  | 'skipped'

// oxlint-disable-next-line typescript/no-extraneous-class
export class WorkerClient {
  private static readonly PORT = 37777
  private static readonly BASE_URL = `http://127.0.0.1:${WorkerClient.PORT}`

  /** Per-process guard so multiple OpenCode windows don't all spawn workers. */
  private static autoStartPromise: Promise<AutoStartResult> | null = null

  /**
   * Check if the worker is healthy
   */
  static async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)

      const response = await fetch(`${this.BASE_URL}/api/health`, {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Ensure the worker is running. If healthy, returns true. Otherwise tries
   * to spawn it via `bunx claude-mem start` in the background and resolves
   * once the worker reports healthy or the timeout is reached.
   *
   * Idempotent + serialised within the process via `autoStartPromise`.
   */
  static async ensureRunning(): Promise<boolean> {
    const result = await this.tryAutoStart()
    return result === 'already-running' || result === 'started'
  }

  /**
   * Try to auto-start the Claude-Mem worker via `bunx claude-mem start`.
   *
   * Behaviour:
   * - If the worker is already healthy, returns 'already-running' immediately.
   * - If `bun` is not on PATH, returns 'no-bun' without attempting to spawn.
   * - Otherwise spawns a detached `bunx claude-mem start` process and polls
   *   /api/health for ~8 seconds. Returns 'started' on success, 'timeout' on
   *   failure to come up, 'spawn-failed' if the spawn itself errored.
   *
   * Concurrent calls share the same in-flight promise.
   */
  static tryAutoStart(): Promise<AutoStartResult> {
    if (!this.autoStartPromise) {
      this.autoStartPromise = this.runAutoStart().catch(() => 'spawn-failed' as AutoStartResult)
    }
    return this.autoStartPromise
  }

  private static async runAutoStart(): Promise<AutoStartResult> {
    if (await this.isHealthy()) {
      return 'already-running'
    }

    const bunPath = this.findBun()
    if (!bunPath) {
      return 'no-bun'
    }

    try {
      const child = spawn(bunPath, ['x', 'claude-mem', 'start'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      })
      child.on('error', () => {
        // swallow — we report failure via timeout/poll outcome
      })
      child.unref()
    } catch {
      return 'spawn-failed'
    }

    for (let i = 0; i < AUTOSTART_POLL_MAX_ATTEMPTS; i++) {
      // Sequential polling is intentional — we need each sleep + health probe
      // to complete before deciding whether to keep waiting.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, AUTOSTART_POLL_INTERVAL_MS))
      // oxlint-disable-next-line no-await-in-loop
      if (await this.isHealthy()) {
        return 'started'
      }
    }
    return 'timeout'
  }

  /**
   * Locate the `bun` executable. Prefers Bun's own runtime detector when the
   * plugin is loaded inside Bun (which OpenCode currently is), then falls back
   * to PATH probing via `process.env.PATH`.
   */
  private static findBun(): string | null {
    // Bun.which is available when running under Bun; safe-typed via `any`.
    const bunGlobal = (globalThis as any).Bun
    if (bunGlobal && typeof bunGlobal.which === 'function') {
      try {
        const found = bunGlobal.which('bun')
        if (typeof found === 'string' && found) {
          return found
        }
      } catch {
        // fall through to PATH probing
      }
    }

    // PATH probe: try `bun` and `bun.exe`. We do not validate executability —
    // spawn() will surface ENOENT via the 'error' event if the path is bogus.
    const path = process.env.PATH || ''
    const sep = process.platform === 'win32' ? ';' : ':'
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
    const slash = process.platform === 'win32' ? '\\' : '/'
    const dirs = path.split(sep).filter(Boolean)
    for (const dir of dirs) {
      const trailing = dir.endsWith('/') || dir.endsWith('\\') ? '' : slash
      for (const ext of exts) {
        const candidate = `${dir}${trailing}bun${ext}`
        try {
          if (existsSync(candidate)) {
            return candidate
          }
        } catch {
          // ignore
        }
      }
    }
    return null
  }

  /**
   * Initialize a session
   */
  static async sessionInit(
    contentSessionId: string,
    project: string,
    prompt: string
  ): Promise<{ sessionDbId: number; promptNumber: number } | null> {
    try {
      const response = await fetch(`${this.BASE_URL}/api/sessions/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId, project, prompt }),
      })
      if (!response.ok) {
        return null
      }
      return (await response.json()) as { sessionDbId: number; promptNumber: number }
    } catch {
      return null
    }
  }

  /**
   * Send observation
   */
  static async sendObservation(
    contentSessionId: string,
    toolName: string,
    toolInput: any,
    toolResponse: any,
    cwd: string
  ): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId,
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd,
        }),
      })
    } catch {
      // silently fail
    }
  }

  /**
   * Trigger summarization
   */
  static async summarize(
    contentSessionId: string,
    lastUserMessage: string,
    lastAssistantMessage: string
  ): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId,
          last_user_message: lastUserMessage,
          last_assistant_message: lastAssistantMessage,
        }),
      })
    } catch {
      // silently fail
    }
  }

  /**
   * Complete session
   */
  static async completeSession(contentSessionId: string): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId }),
      })
    } catch {
      // silently fail
    }
  }

  /**
   * Get pre-formatted context for system prompt injection.
   * Uses /api/context/inject which returns rich markdown with observations + session summaries.
   */
  static async getContext(project: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.BASE_URL}/api/context/inject?project=${encodeURIComponent(project)}`
      )
      if (!response.ok) {
        return null
      }
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const data: any = await response.json()
        if (typeof data === 'string') {
          return data
        }
        if (data && typeof data.content === 'string') {
          return data.content
        }
        const text = JSON.stringify(data, null, 2)
        return text === '{}' || text === 'null' ? null : text
      }
      // Worker returns text/plain markdown
      const text = await response.text()
      return text.trim() || null
    } catch {
      return null
    }
  }
}
