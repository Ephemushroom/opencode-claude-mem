/**
 * Starts the claude-mem Worker when nothing answers on its port, the way Claude Code's
 * SessionStart hook does: by running the launcher `npx claude-mem install` placed.
 * A Worker that answers, even with an error, is never restarted or replaced; version
 * management stays with claude-mem itself.
 */
import {
  getWorkerBaseUrl,
  getWorkerEndpoint,
  isLoopbackHost,
  isRecord,
  readWorkerSetting,
} from './worker-client'
import { posix, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const HEALTH_TIMEOUT_MS = 3000
const START_WAIT_MS = 30_000
const START_POLL_MS = 500
const REFUSED_CODES = new Set(['ECONNREFUSED', 'ConnectionRefused'])

export type WorkerState =
  /** `version` is null when the Worker answered without a readable version. */
  | { readonly status: 'running'; readonly version: string | null }
  /** No launcher: claude-mem is not installed on this machine. */
  | { readonly status: 'missing' }
  /** Not running, and this machine is told not to start it (or it runs elsewhere). */
  | { readonly status: 'disabled' }
  /** The launcher ran, and the port still does not answer. */
  | { readonly status: 'failed' }

export interface WorkerStartDeps {
  /** Null only when the connection was refused, meaning no Worker holds the port. */
  readonly probe: () => Promise<{ version: string | null } | null>
  readonly disabled: () => boolean
  readonly launcher: () => string | null
  /** Resolves false when the launcher could not be spawned. */
  readonly start: (launcher: string) => Promise<boolean>
  readonly waitMs: number
  readonly pollMs: number
}

/**
 * True for a refused connection, however the runtime reports it: Bun sets
 * `code: 'ConnectionRefused'`, Node keeps ECONNREFUSED on `cause` or nested `errors`.
 */
export function isConnectionRefused(error: unknown, seen = new Set<unknown>()): boolean {
  if (typeof error !== 'object' || error === null || seen.has(error)) {
    return false
  }
  seen.add(error)
  if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
    return true
  }
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown }
  return (
    (typeof code === 'string' && REFUSED_CODES.has(code)) ||
    isConnectionRefused(cause, seen) ||
    (Array.isArray(errors) && errors.some((nested) => isConnectionRefused(nested, seen)))
  )
}

/** Where `npx claude-mem install` places the launcher (claude-mem's install-launcher.ts). */
export function launcherPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string
): string {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] || win32.join(home, 'AppData', 'Local')
    return win32.join(local, 'claude-mem', 'bin', 'claude-mem.exe')
  }
  return posix.join(home, '.local', 'bin', 'claude-mem')
}

/**
 * claude-mem's own switches for "do not start a Worker here": an explicit Worker URL,
 * `CLAUDE_MEM_WORKER_AUTOSTART=false`, or a Worker host that is another machine.
 */
export function autostartDisabled(
  read: (key: string) => string | null,
  host: string = getWorkerEndpoint().host
): boolean {
  return (
    Boolean(read('CLAUDE_MEM_WORKER_URL')) ||
    read('CLAUDE_MEM_WORKER_AUTOSTART')?.toLowerCase() === 'false' ||
    !isLoopbackHost(host)
  )
}

async function probeWorker(): Promise<{ version: string | null } | null> {
  try {
    const response = await fetch(`${getWorkerBaseUrl()}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!response.ok) {
      return { version: null }
    }
    const body: unknown = await response.json()
    const version = isRecord(body) ? body['version'] : null
    return { version: typeof version === 'string' ? version : null }
  } catch (error) {
    // A timeout or reset came from something holding the port; only a refusal means absent.
    return isConnectionRefused(error) ? null : { version: null }
  }
}

function findLauncher(): string | null {
  const placed = launcherPath(process.platform, process.env, homedir())
  return existsSync(placed) ? placed : Bun.which('claude-mem')
}

function runLauncher(launcher: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `start` waits for readiness and exits; the daemon it leaves behind is claude-mem's own.
    const child = spawn(launcher, ['start'], { detached: true, stdio: 'ignore', windowsHide: true })
    // A missing or blocked launcher is reported through `error`, not thrown.
    child.once('error', () => resolve(false))
    child.once('spawn', () => resolve(true))
    child.unref()
  })
}

const DEFAULT_DEPS: WorkerStartDeps = {
  probe: probeWorker,
  disabled: () => autostartDisabled(readWorkerSetting),
  launcher: findLauncher,
  start: runLauncher,
  waitMs: START_WAIT_MS,
  pollMs: START_POLL_MS,
}

/** The Worker as it is now, without starting anything. */
export async function workerState(deps: WorkerStartDeps = DEFAULT_DEPS): Promise<WorkerState> {
  const running = await deps.probe()
  if (running) {
    return { status: 'running', version: running.version }
  }
  if (deps.disabled()) {
    return { status: 'disabled' }
  }
  return deps.launcher() ? { status: 'failed' } : { status: 'missing' }
}

async function startWorker(deps: WorkerStartDeps): Promise<WorkerState> {
  const running = await deps.probe()
  if (running) {
    return { status: 'running', version: running.version }
  }
  if (deps.disabled()) {
    return { status: 'disabled' }
  }
  const launcher = deps.launcher()
  if (!launcher) {
    return { status: 'missing' }
  }
  const spawned = await deps.start(launcher).catch(() => false)
  if (!spawned) {
    return { status: 'failed' }
  }
  const deadline = Date.now() + deps.waitMs
  while (Date.now() < deadline) {
    // Polling is the point: each probe must follow the previous wait.
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(deps.pollMs)
    // eslint-disable-next-line no-await-in-loop
    const started = await deps.probe()
    if (started) {
      return { status: 'running', version: started.version }
    }
  }
  return { status: 'failed' }
}

let pending: Promise<WorkerState> | null = null

/** One start at a time per process; every caller during it gets the same answer. */
export function ensureWorker(deps: WorkerStartDeps = DEFAULT_DEPS): Promise<WorkerState> {
  if (deps !== DEFAULT_DEPS) {
    return startWorker(deps)
  }
  pending ??= startWorker(deps).finally(() => {
    pending = null
  })
  return pending
}
