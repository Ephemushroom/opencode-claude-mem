/**
 * Read-only Worker client for the Memory sidebar.
 * Capture, context injection and search belong to the official claude-mem OpenCode plugin.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_WORKER_HOST = '127.0.0.1'
const DEFAULT_WORKER_PORT = 37777
const SETTINGS_FILE = join(homedir(), '.claude-mem', 'settings.json')
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

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
  if (!LOOPBACK_HOSTS.has(parseWorkerEndpoint(env, rawSettings).host)) {
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
    return readFileSync(SETTINGS_FILE, 'utf8')
  } catch {
    return null
  }
}

export function getWorkerBaseUrl(): string {
  const endpoint = parseWorkerEndpoint(process.env, readSettingsRaw())
  return `http://${endpoint.host}:${endpoint.port}`
}

// oxlint-disable-next-line typescript/no-extraneous-class
export class WorkerClient {
  private static readonly BASE_URL = getWorkerBaseUrl()
  private static readonly DATABASE_PATH = resolveDatabasePath(
    process.env,
    readSettingsRaw(),
    homedir()
  )

  /**
   * Per-project counts, read from the Worker's database in read-only mode. The Worker's
   * HTTP API only reports global totals. Null when the database is remote, missing,
   * locked or of an unknown schema; the sidebar then falls back to the global totals.
   */
  static getProjectCounts(project: string): Promise<ProjectCounts | null> {
    return this.DATABASE_PATH
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
  ): Promise<{ id: number; request: string; at: number | null }[]> {
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
      const response = await fetch(`${this.BASE_URL}/api/${path}/${id}`)
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
