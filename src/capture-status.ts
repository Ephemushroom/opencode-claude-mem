/**
 * What the server part last reported for a checkout, for the sidebar. The two can run in
 * different processes, so the state travels through a small file in this package's cache
 * directory, one per running server instance and checkout.
 */
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'

export interface CaptureStatus {
  /** `problem`: nothing is capturing this checkout's sessions. */
  readonly state: 'ok' | 'problem'
  /** Empty when there is nothing to tell the user. */
  readonly message: string
}

/** Holds the official claude-mem files this package downloads, and the status files. */
export function cacheDirectory(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  return join(env['XDG_CACHE_HOME']?.trim() || join(home, '.cache'), 'opencode-claude-mem')
}

/** Names the status files of one checkout, however its path was spelled. */
export function statusKey(directory: string): string {
  let resolved = resolve(directory)
  try {
    // The server part and the sidebar may name the same checkout through different links.
    resolved = realpathSync(directory)
  } catch {
    // A checkout that is gone keeps its absolute name.
  }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists and belongs to someone else.
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

function parseStatus(file: string): (CaptureStatus & { pid: number }) | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const { state, message, pid } = parsed as { state?: unknown; message?: unknown; pid?: unknown }
    return (state === 'ok' || state === 'problem') &&
      typeof message === 'string' &&
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid > 0
      ? { state, message, pid }
      : null
  } catch {
    return null
  }
}

/**
 * The newest status a running server part wrote for this checkout, preferring one from
 * this process. Null when none is running: a status left by a package that was since
 * removed from `opencode.json`, or by a process that exited, must not stay on screen.
 */
export function readCaptureStatus(
  directory: string,
  dir: string = cacheDirectory()
): CaptureStatus | null {
  const folder = join(dir, 'status')
  const prefix = `${statusKey(directory)}.`
  let names: string[] = []
  try {
    names = readdirSync(folder).filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
  } catch {
    return null
  }
  let best: { status: CaptureStatus; own: boolean; at: number } | null = null
  for (const name of names) {
    const file = join(folder, name)
    const parsed = parseStatus(file)
    if (!parsed || !isAlive(parsed.pid)) {
      // Left by a process that exited without unloading the plugin.
      rmSync(file, { force: true })
    } else {
      const own = parsed.pid === process.pid
      const at = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0
      if (!best || (own && !best.own) || (own === best.own && at > best.at)) {
        best = { status: { state: parsed.state, message: parsed.message }, own, at }
      }
    }
  }
  return best?.status ?? null
}

export interface CaptureStatusWriter {
  readonly write: (status: CaptureStatus) => void
  /** Called when the server part is unloaded for the checkout while the host keeps running. */
  readonly clear: () => void
}

/**
 * The status file of one `setup` call. Each has its own, so two servers on one checkout,
 * or a reload that sets up before the old instance is disposed, never remove each other's.
 */
export function captureStatusWriter(
  directory: string,
  dir: string = cacheDirectory()
): CaptureStatusWriter {
  const folder = join(dir, 'status')
  const file = join(
    folder,
    `${statusKey(directory)}.${process.pid}.${randomUUID().slice(0, 8)}.json`
  )
  return {
    write(status) {
      try {
        mkdirSync(folder, { recursive: true })
        // Staged beside the target so a reader never sees half a file.
        const staged = `${file}.tmp`
        writeFileSync(staged, `${JSON.stringify({ ...status, pid: process.pid })}\n`)
        renameSync(staged, file)
      } catch {
        // The sidebar then shows no status, as it does without the server part.
      }
    },
    clear() {
      try {
        rmSync(file, { force: true })
      } catch {
        // Readers ignore the file once this process exits.
      }
    },
  }
}
