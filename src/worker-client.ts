/**
 * Worker Client for Claude-Mem
 * Handles communication with the local worker service.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const HEALTH_TIMEOUT_MS = 1000
const AUTOSTART_POLL_INTERVAL_MS = 500
const AUTOSTART_POLL_MAX_ATTEMPTS = 16
const DEFAULT_WORKER_HOST = '127.0.0.1'
const DEFAULT_WORKER_PORT = 37777
const PLATFORM_SOURCE = 'opencode'
const SETTINGS_FILE = join(homedir(), '.claude-mem', 'settings.json')

export interface WorkerEndpoint {
  readonly host: string
  readonly port: number
}

type JsonRecord = Record<string, unknown>

export type AutoStartResult =
  | 'already-running'
  | 'started'
  | 'no-bun'
  | 'spawn-failed'
  | 'timeout'
  | 'skipped'

export type SearchOrder = 'date_desc' | 'date_asc' | 'relevance'

export interface SearchOptions {
  readonly query?: string
  readonly limit?: number
  readonly project?: string
  readonly platformSource?: string
  readonly type?: string
  readonly obs_type?: string
  readonly dateStart?: string
  readonly dateEnd?: string
  readonly offset?: number
  readonly orderBy?: SearchOrder
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function readPort(value: unknown): number | null {
  const text = readString(value)
  if (!text || !/^\d+$/.test(text)) {
    return null
  }
  const port = Number(text)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function parseSettings(rawSettings: string | null): JsonRecord {
  if (!rawSettings) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(rawSettings)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function parseWorkerEndpoint(
  env: Record<string, string | undefined>,
  rawSettings: string | null
): WorkerEndpoint {
  const settings = parseSettings(rawSettings)
  const host =
    readString(env['CLAUDE_MEM_WORKER_HOST']) ??
    readString(settings['CLAUDE_MEM_WORKER_HOST']) ??
    DEFAULT_WORKER_HOST
  const port =
    readPort(env['CLAUDE_MEM_WORKER_PORT']) ??
    readPort(settings['CLAUDE_MEM_WORKER_PORT']) ??
    DEFAULT_WORKER_PORT

  return { host, port }
}

export function buildSearchParams(options: SearchOptions): URLSearchParams {
  const params = new URLSearchParams()
  const entries: readonly (readonly [string, string | number | undefined])[] = [
    ['query', options.query ?? ''],
    ['limit', options.limit],
    ['project', options.project],
    ['platformSource', options.platformSource],
    ['type', options.type],
    ['obs_type', options.obs_type],
    ['dateStart', options.dateStart],
    ['dateEnd', options.dateEnd],
    ['offset', options.offset],
    ['orderBy', options.orderBy],
  ]

  for (const [key, value] of entries) {
    if (value !== undefined) {
      params.set(key, String(value))
    }
  }

  return params
}

function readSettingsRaw(): string | null {
  try {
    return readFileSync(SETTINGS_FILE, 'utf8')
  } catch {
    return null
  }
}

function getWorkerBaseUrl(): string {
  const endpoint = parseWorkerEndpoint(process.env, readSettingsRaw())
  return `http://${endpoint.host}:${endpoint.port}`
}

function extractTextContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (!isRecord(value)) {
    return null
  }
  const { content } = value
  if (typeof content === 'string') {
    return content.trim() || null
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') {
          return ''
        }
        return part['text']
      })
      .filter(Boolean)
      .join('\n')
      .trim()
    return text || null
  }
  const text = JSON.stringify(value, null, 2)
  return text === '{}' || text === 'null' ? null : text
}

// oxlint-disable-next-line typescript/no-extraneous-class
export class WorkerClient {
  private static readonly BASE_URL = getWorkerBaseUrl()

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
        body: JSON.stringify({
          contentSessionId,
          project,
          prompt,
          platformSource: PLATFORM_SOURCE,
        }),
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
          platformSource: PLATFORM_SOURCE,
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
          platformSource: PLATFORM_SOURCE,
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
        body: JSON.stringify({ contentSessionId, platformSource: PLATFORM_SOURCE }),
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
        return extractTextContent(await response.json())
      }
      // Worker returns text/plain markdown
      const text = await response.text()
      return text.trim() || null
    } catch {
      return null
    }
  }

  /**
   * Timeline: get chronological context around an observation anchor or query.
   * Mirrors the upstream MCP `timeline` tool (GET /api/timeline).
   */
  static async timeline(options: {
    project: string
    anchor?: number
    query?: string
    depthBefore?: number
    depthAfter?: number
  }): Promise<string> {
    try {
      const params = new URLSearchParams({ project: options.project })
      if (options.anchor !== undefined) {
        params.set('anchor', String(options.anchor))
      }
      if (options.query) {
        params.set('query', options.query)
      }
      if (options.depthBefore !== undefined) {
        params.set('depth_before', String(options.depthBefore))
      }
      if (options.depthAfter !== undefined) {
        params.set('depth_after', String(options.depthAfter))
      }

      const response = await fetch(`${this.BASE_URL}/api/timeline?${params.toString()}`)
      if (!response.ok) {
        return ''
      }
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        return extractTextContent(await response.json()) || ''
      }
      const text = await response.text()
      return text.trim()
    } catch {
      return ''
    }
  }

  /**
   * Fetch full observation details by IDs.
   * Mirrors the upstream MCP `get_observations` tool (POST /api/observations/batch).
   */
  static async getObservations(ids: number[], project?: string): Promise<string> {
    try {
      const body: JsonRecord = { ids }
      if (project) {
        body['project'] = project
      }
      const response = await fetch(`${this.BASE_URL}/api/observations/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        return ''
      }
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const payload: unknown = await response.json()
        // /api/observations/batch returns a raw JSON array of observation rows
        if (Array.isArray(payload)) {
          return payload.length ? JSON.stringify(payload, null, 2) : ''
        }
        return extractTextContent(payload) || ''
      }
      const text = await response.text()
      return text.trim()
    } catch {
      return ''
    }
  }

  /**
   * Fetch worker + database stats plus processing status for the sidebar view.
   * Combines GET /api/stats and GET /api/processing-status; null when offline.
   */
  static async getStats(): Promise<{
    database?: { observations?: number; sessions?: number; summaries?: number }
    processing?: { isProcessing?: boolean; queueDepth?: number }
  } | null> {
    try {
      const [statsRes, processingRes] = await Promise.all([
        fetch(`${this.BASE_URL}/api/stats`),
        fetch(`${this.BASE_URL}/api/processing-status`),
      ])
      if (!statsRes.ok) {
        return null
      }
      const stats = (await statsRes.json()) as {
        database?: { observations?: number; sessions?: number; summaries?: number }
      }
      const processing = processingRes.ok
        ? ((await processingRes.json()) as { isProcessing?: boolean; queueDepth?: number })
        : undefined
      return { database: stats.database, processing }
    } catch {
      return null
    }
  }

  /**
   * Recent session summaries for the sidebar (GET /api/summaries).
   */
  static async getRecentSummaries(
    project: string,
    limit: number
  ): Promise<{ id: number; request: string }[]> {
    try {
      const params = new URLSearchParams({ project, limit: String(limit) })
      const response = await fetch(`${this.BASE_URL}/api/summaries?${params.toString()}`)
      if (!response.ok) {
        return []
      }
      const payload = (await response.json()) as { items?: unknown }
      if (!Array.isArray(payload.items)) {
        return []
      }
      return payload.items.flatMap((item) => {
        if (!isRecord(item) || typeof item['id'] !== 'number') {
          return []
        }
        const request = typeof item['request'] === 'string' ? item['request'].trim() : ''
        return request ? [{ id: item['id'], request }] : []
      })
    } catch {
      return []
    }
  }

  /**
   * Recent observations for the sidebar (GET /api/observations).
   */
  static async getRecentObservations(
    project: string,
    limit: number
  ): Promise<{ id: number; type: string; title: string }[]> {
    try {
      const params = new URLSearchParams({ project, limit: String(limit) })
      const response = await fetch(`${this.BASE_URL}/api/observations?${params.toString()}`)
      if (!response.ok) {
        return []
      }
      const payload = (await response.json()) as { items?: unknown }
      if (!Array.isArray(payload.items)) {
        return []
      }
      return payload.items.flatMap((item) => {
        if (!isRecord(item) || typeof item['id'] !== 'number') {
          return []
        }
        const title = typeof item['title'] === 'string' ? item['title'].trim() : ''
        const type = typeof item['type'] === 'string' ? item['type'] : ''
        return title ? [{ id: item['id'], type, title }] : []
      })
    } catch {
      return []
    }
  }

  static async search(options: SearchOptions): Promise<string> {
    try {
      const params = buildSearchParams(options)

      const response = await fetch(`${this.BASE_URL}/api/search?${params.toString()}`)
      if (!response.ok) {
        return ''
      }
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        return extractTextContent(await response.json()) || ''
      }
      const text = await response.text()
      return text.trim()
    } catch {
      return ''
    }
  }
}
