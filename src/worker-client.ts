/**
 * Where the claude-mem Worker is and how to talk to it, plus the read-only client the
 * Memory sidebar uses. The endpoint rules follow claude-mem itself (its settings file,
 * default port and local token), so every part of this package reaches the same Worker
 * the official plugin captures into.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const DEFAULT_WORKER_HOST = '127.0.0.1'
const WORKER_PORT_BASE = 37700
const TOKEN_HEADER = 'x-claude-mem-token'

// Same project filter the Worker's /api/observations and /api/summaries use, so the
// counts agree with the rows the sidebar lists.
const PROJECT_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM observations
    WHERE project = ?1 COLLATE NOCASE OR merged_into_project = ?1 COLLATE NOCASE) AS observations,
  (SELECT COUNT(*) FROM session_summaries
    WHERE project = ?1 COLLATE NOCASE OR merged_into_project = ?1 COLLATE NOCASE) AS summaries,
  (SELECT COUNT(*) FROM sdk_sessions WHERE project = ?1 COLLATE NOCASE) AS sessions`

export interface WorkerEndpoint {
  readonly host: string
  readonly port: number
}

export interface ProjectCounts {
  readonly observations: number
  readonly summaries: number
  readonly sessions: number
}

type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
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

/** settings.json is flat, or keeps its keys under `env`; either may start with a BOM. */
function parseSettings(rawSettings: string | null): JsonRecord {
  if (!rawSettings) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(rawSettings.replace(/^\uFEFF/, ''))
    if (!isRecord(parsed)) {
      return {}
    }
    const nested = parsed['env']
    const source =
      isRecord(nested) && Object.keys(nested).some((key) => key.startsWith('CLAUDE_MEM_'))
        ? nested
        : parsed
    // claude-mem accepts `37777` and `false` written as JSON numbers and booleans.
    return Object.fromEntries(
      Object.entries(source).map(([key, value]) => [
        key,
        typeof value === 'number' || typeof value === 'boolean' ? String(value) : value,
      ])
    )
  } catch {
    return {}
  }
}

/** claude-mem's data directory, which holds its settings.json: the environment, else ~/.claude-mem. */
export function dataDirectory(env: Record<string, string | undefined>, home: string): string {
  const dir = readString(env['CLAUDE_MEM_DATA_DIR']) ?? join(home, '.claude-mem')
  return dir.replace(/^~(?=$|[\\/])/, home)
}

/**
 * The port a Worker uses when none is configured: 37700 plus the user id's last two
 * digits, or on Windows (no user id) a number derived from the data directory.
 */
export function defaultWorkerPort(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null
): number {
  if (uid !== null) {
    return WORKER_PORT_BASE + (((uid % 100) + 100) % 100)
  }
  const normalized = platform === 'win32' ? win32.resolve(dataDir).toLowerCase() : resolve(dataDir)
  const digest = createHash('sha256').update(normalized, 'utf8').digest()
  return WORKER_PORT_BASE + (digest.readUInt32BE(0) % 100)
}

export function parseWorkerEndpoint(
  env: Record<string, string | undefined>,
  rawSettings: string | null,
  fallbackPort: number = defaultWorkerPort(dataDirectory(env, homedir()))
): WorkerEndpoint {
  const settings = parseSettings(rawSettings)
  const configured =
    readString(env['CLAUDE_MEM_WORKER_HOST']) ??
    readString(settings['CLAUDE_MEM_WORKER_HOST']) ??
    DEFAULT_WORKER_HOST
  // As claude-mem does: `localhost` may resolve to IPv6, where another service can listen.
  const host = configured === 'localhost' ? DEFAULT_WORKER_HOST : configured
  const port =
    readPort(env['CLAUDE_MEM_WORKER_PORT']) ??
    readPort(settings['CLAUDE_MEM_WORKER_PORT']) ??
    fallbackPort

  return { host, port }
}

/** True for this machine: localhost, *.localhost, ::1 and 127.0.0.0/8. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '::1' ||
    /^127(?:\.\d{1,3}){1,3}$/.test(name)
  )
}

/** An IPv6 host needs brackets inside a URL. */
export function workerUrl(endpoint: WorkerEndpoint): string {
  const host =
    endpoint.host.includes(':') && !endpoint.host.startsWith('[')
      ? `[${endpoint.host}]`
      : endpoint.host
  return `http://${host}:${endpoint.port}`
}

/**
 * The header a Worker with `CLAUDE_MEM_LOCAL_API_TOKEN` requires on everything but its
 * health check. The token is read from the settings file only, and is sent only to a
 * Worker on this machine.
 */
export function tokenHeaders(baseUrl: string, rawSettings: string | null): Record<string, string> {
  const token = readString(parseSettings(rawSettings)['CLAUDE_MEM_LOCAL_API_TOKEN'])
  try {
    return token && isLoopbackHost(new URL(baseUrl).hostname) ? { [TOKEN_HEADER]: token } : {}
  } catch {
    return {}
  }
}

/**
 * The Worker's SQLite database: CLAUDE_MEM_DATA_DIR from env, then settings, then
 * ~/.claude-mem. Null when the Worker is not on this machine, because a local file would
 * then describe a different store.
 */
export function resolveDatabasePath(
  env: Record<string, string | undefined>,
  rawSettings: string | null,
  home: string
): string | null {
  if (!isLoopbackHost(parseWorkerEndpoint(env, rawSettings).host)) {
    return null
  }
  const settings = parseSettings(rawSettings)
  const dir =
    readString(env['CLAUDE_MEM_DATA_DIR']) ??
    readString(settings['CLAUDE_MEM_DATA_DIR']) ??
    join(home, '.claude-mem')
  return join(dir.replace(/^~(?=$|[\\/])/, home), 'claude-mem.db')
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Read-only per-project counts; null on a missing, locked or unexpected database. */
export async function readProjectCounts(
  path: string,
  project: string
): Promise<ProjectCounts | null> {
  if (!existsSync(path)) {
    return null
  }
  try {
    const { Database } = await import('bun:sqlite')
    const db = new Database(path, { readonly: true })
    try {
      const row: unknown = db.query(PROJECT_COUNTS_SQL).get(project)
      if (!isRecord(row)) {
        return null
      }
      const observations = readCount(row['observations'])
      const summaries = readCount(row['summaries'])
      const sessions = readCount(row['sessions'])
      return observations === null || summaries === null || sessions === null
        ? null
        : { observations, summaries, sessions }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function readEpoch(item: Record<string, unknown>): number | null {
  const at = item['created_at_epoch']
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

function readSettingsRaw(): string | null {
  try {
    return readFileSync(join(dataDirectory(process.env, homedir()), 'settings.json'), 'utf8')
  } catch {
    return null
  }
}

/** A claude-mem setting: the environment first, then the data directory's settings.json. */
export function readWorkerSetting(key: string): string | null {
  return readString(process.env[key]) ?? readString(parseSettings(readSettingsRaw())[key])
}

export function getWorkerEndpoint(): WorkerEndpoint {
  return parseWorkerEndpoint(process.env, readSettingsRaw())
}

export function getWorkerBaseUrl(): string {
  return workerUrl(getWorkerEndpoint())
}

/** Headers for a request to `baseUrl`: the local token when that Worker needs one. */
export function workerHeaders(baseUrl: string = getWorkerBaseUrl()): Record<string, string> {
  return tokenHeaders(baseUrl, readSettingsRaw())
}

// oxlint-disable-next-line typescript/no-extraneous-class
export class WorkerClient {
  private static readonly BASE_URL = getWorkerBaseUrl()
  // The official OpenCode plugin cannot target an explicit Worker URL, so the server part
  // captures nothing; reading the host-and-port Worker instead would show another store.
  private static readonly SUPPORTED = !readWorkerSetting('CLAUDE_MEM_WORKER_URL')
  private static readonly DATABASE_PATH = resolveDatabasePath(
    process.env,
    readSettingsRaw(),
    homedir()
  )

  private static get(path: string): Promise<Response> {
    if (!this.SUPPORTED) {
      return Promise.reject(new Error('CLAUDE_MEM_WORKER_URL is not supported'))
    }
    // Headers are read per request, so a token set later is picked up. A redirect is an
    // error: it would carry the token to another origin.
    return fetch(`${this.BASE_URL}${path}`, {
      headers: workerHeaders(this.BASE_URL),
      redirect: 'error',
    })
  }

  /**
   * Per-project counts, read from the Worker's database in read-only mode. The Worker's
   * HTTP API only reports global totals. Null when the database is remote, missing,
   * locked or of an unknown schema; the sidebar then falls back to the global totals.
   */
  static getProjectCounts(project: string): Promise<ProjectCounts | null> {
    return this.DATABASE_PATH && this.SUPPORTED
      ? readProjectCounts(this.DATABASE_PATH, project)
      : Promise.resolve(null)
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
        this.get(`/api/stats`),
        this.get(`/api/processing-status`),
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
  ): Promise<{ id: number; request: string; at: number | null }[]> {
    try {
      const params = new URLSearchParams({ project, limit: String(limit) })
      const response = await this.get(`/api/summaries?${params.toString()}`)
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
        return request ? [{ id: item['id'], request, at: readEpoch(item) }] : []
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
  ): Promise<{ id: number; type: string; title: string; at: number | null }[]> {
    try {
      const params = new URLSearchParams({ project, limit: String(limit) })
      const response = await this.get(`/api/observations?${params.toString()}`)
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
        return title ? [{ id: item['id'], type, title, at: readEpoch(item) }] : []
      })
    } catch {
      return []
    }
  }

  /**
   * One observation (GET /api/observation/:id) or session summary (GET /api/session/:id)
   * for the detail dialog; null when missing or offline.
   */
  static async getDetail(
    kind: 'summary' | 'observation',
    id: number
  ): Promise<Record<string, unknown> | null> {
    try {
      const path = kind === 'observation' ? 'observation' : 'session'
      const response = await this.get(`/api/${path}/${id}`)
      if (!response.ok) {
        return null
      }
      const payload: unknown = await response.json()
      return isRecord(payload) ? payload : null
    } catch {
      return null
    }
  }
}
