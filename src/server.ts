/**
 * OpenCode V2 server plugin: one package entry that brings claude-mem to OpenCode.
 *
 * Capture and context injection stay upstream code: this plugin downloads the official
 * claude-mem OpenCode plugin at the running Worker's version and runs its `setup` with
 * this plugin's context. On top of that it registers the memory tools the official plugin
 * leaves to claude-mem's MCP server, starts the Worker when it is not running, and reports
 * what happened to the sidebar. Loaded from `opencode.json`:
 *
 * ```json
 * { "plugins": ["@ephemushroom/opencode-claude-mem"] }
 * ```
 *
 * `{ "package": "...", "options": { "mcp": true } }` registers claude-mem's MCP server
 * (all of its tools, in a separate process) instead of this plugin's own tools.
 */
import { type CaptureStatusWriter, captureStatusWriter } from './capture-status'
import { TOOL_NAMESPACE, createWorkerTools } from './worker-tools'
import { dirname, join } from 'node:path'
import { ensureWorker, workerState } from './worker-start'
import { isRecord, readWorkerSetting } from './worker-client'
import type { Plugin } from '@opencode/plugin'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { syncOfficial } from './official-sync'

const MCP_SERVER_NAME = 'claude-mem'
const OFFICIAL_PLUGIN_ID = 'claude-mem'
// The host lists plugins only once all of them are set up, this one included, so a
// standalone copy can be confirmed a moment after `setup` returns at the earliest.
const HOST_LIST_POLL_MS = 250
const HOST_LIST_WAIT_MS = 10_000
// Setup holds the session's first request, so it waits this long for the common case
// (Worker running, files on disk) and lets a Worker start or a download finish behind it.
const SETUP_WAIT_MS = 2000
// After a failed attempt, look again this often: the user may install claude-mem, start
// the Worker or get back online while OpenCode stays open.
const RETRY_INTERVAL_MS = 60_000
const WORKER_PROBLEMS = {
  missing: 'claude-mem is not installed: npx claude-mem install',
  failed: 'Worker is not running: npx claude-mem start',
  disabled: 'Worker is not running, and CLAUDE_MEM_WORKER_AUTOSTART is off',
} as const

type Cleanup = () => Promise<void> | void

/** What a capture pass needs from the host; `Plugin.Context` satisfies it. */
export interface CaptureContext {
  readonly mcp: Pick<Plugin.Context['mcp'], 'transform'>
  /** The host's plugins for this checkout; its result is read defensively. */
  readonly plugin: { readonly list: () => Promise<unknown> }
}

/**
 * What the host says about a plugin with the official id: loaded and running, loaded and
 * failed, not among its plugins, or `unknown` while its list is still empty.
 */
export type OfficialPluginState = 'active' | 'failed' | 'absent' | 'unknown'

export async function officialPluginState(ctx: CaptureContext): Promise<OfficialPluginState> {
  try {
    const result = await ctx.plugin.list()
    const data = isRecord(result) ? result['data'] : result
    if (!Array.isArray(data) || data.length === 0) {
      return 'unknown'
    }
    const entry: unknown = data.find((item) => isRecord(item) && item['id'] === OFFICIAL_PLUGIN_ID)
    if (!isRecord(entry)) {
      return 'absent'
    }
    return isRecord(entry['state']) && entry['state']['status'] === 'active' ? 'active' : 'failed'
  } catch {
    return 'unknown'
  }
}

/** One `setup` call: the host runs it once per checkout it serves. */
export interface CaptureSession {
  readonly ctx: CaptureContext
  readonly directory: string
  readonly status: CaptureStatusWriter
  readonly useMcp: boolean
  readonly keep: (cleanup: Cleanup) => void
  readonly disposed: () => boolean
  /** Something records this checkout's sessions: the copy loaded here, or a standalone one the host confirmed. */
  capturing: boolean
  mcpRegistered: boolean
}

/**
 * True when the official plugin exists as a standalone file, the way
 * `npx claude-mem install --ide opencode` leaves it in the config directory, or a project
 * keeps it under `.opencode` in the checkout or a directory above it. OpenCode normally
 * loads that file by itself, and a second copy here would record every prompt and tool
 * call twice. The file alone proves nothing: whether it runs is the host's to say
 * (`officialPluginState`).
 */
export function standalonePluginInstalled(
  env: Record<string, string | undefined>,
  home: string,
  directory: string
): boolean {
  const config =
    env['OPENCODE_CONFIG_DIR']?.trim() ||
    join(env['XDG_CONFIG_HOME']?.trim() || join(home, '.config'), 'opencode')
  const roots = [config]
  for (let dir = directory; ; dir = dirname(dir)) {
    roots.push(join(dir, '.opencode'))
    if (dirname(dir) === dir) {
      break
    }
  }
  // The host scans both directory names under each root.
  return roots.some((root) =>
    ['plugins', 'plugin'].some((name) => existsSync(join(root, name, 'claude-mem.js')))
  )
}

/** claude-mem's MCP server is a Node script; without Node the host binary runs it as Bun. */
export function mcpServerCommand(
  script: string,
  node: string | null,
  host: string
): { command: string[]; environment?: Record<string, string> } {
  return node
    ? { command: [node, script] }
    : { command: [host, script], environment: { BUN_BE_BUN: '1' } }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Null when the session was disposed before the official `setup` could run. */
async function loadOfficialPlugin(
  file: string,
  ctx: CaptureContext,
  disposed: () => boolean
): Promise<Cleanup | null> {
  const module: { default?: { setup?: (context: CaptureContext) => unknown } } = await import(
    pathToFileURL(file).href
  )
  const setup = module.default?.setup
  if (typeof setup !== 'function') {
    throw new TypeError('it has no OpenCode 2 entry point')
  }
  if (disposed()) {
    return null
  }
  const cleanup = await setup(ctx)
  return typeof cleanup === 'function' ? (cleanup as Cleanup) : () => {}
}

/**
 * One pass over what is still missing: a running Worker, the official files at exactly its
 * version, capture, and the MCP server when asked for. Resolves true when nothing is left
 * to do. Each step is recorded only after it succeeded, so a later pass never repeats it:
 * a second `setup` of the official plugin would record everything twice. Only the first
 * pass starts the Worker; later ones look at what is there, so a Worker that crashes on
 * start is not launched again every minute.
 */
export async function attemptCapture(session: CaptureSession, first: boolean): Promise<boolean> {
  const { directory } = session
  const unfinished = (message: string): false => {
    if (!session.disposed()) {
      session.status.write({
        state: session.capturing ? 'ok' : 'problem',
        message: session.capturing ? message : `capture off · ${message}`,
      })
    }
    return false
  }

  const worker = await (first ? ensureWorker() : workerState())
  if (session.disposed()) {
    return true
  }
  if (!session.capturing) {
    const fileFound = standalonePluginInstalled(process.env, homedir(), directory)
    let standalone = await officialPluginState(session.ctx)
    // Without the file there is nothing to wait for: this package's copy is loaded at once,
    // so its hooks are in place before the session's first prompt.
    const deadline = fileFound ? Date.now() + HOST_LIST_WAIT_MS : 0
    while (standalone === 'unknown' && Date.now() < deadline && !session.disposed()) {
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(HOST_LIST_POLL_MS)
      // eslint-disable-next-line no-await-in-loop
      standalone = await officialPluginState(session.ctx)
    }
    if (session.disposed()) {
      return true
    }
    if (standalone === 'active') {
      session.capturing = true
    } else if (fileFound && standalone !== 'failed') {
      // Present but not confirmed as running: claiming capture could be wrong, and loading
      // a copy here could double it. A copy the host reports as failed is replaced below.
      return unfinished(
        'plugins/claude-mem.js is present but OpenCode has not loaded it: remove the file, or enable the claude-mem plugin'
      )
    }
  }
  if (worker.status !== 'running') {
    return unfinished(WORKER_PROBLEMS[worker.status])
  }
  if (session.capturing && (!session.useMcp || session.mcpRegistered)) {
    // A standalone copy captures and nothing else is asked for: no files are needed.
    session.status.write({ state: 'ok', message: '' })
    return true
  }
  // The official plugin must match the Worker's API: no version, no guess.
  if (!worker.version) {
    return unfinished('the Worker did not report its version')
  }
  const synced = await syncOfficial(worker.version)
  if (session.disposed()) {
    return true
  }
  if (!synced.ok) {
    return unfinished(`claude-mem ${worker.version} download failed: ${synced.reason}`)
  }

  if (!session.capturing) {
    try {
      const cleanup = await loadOfficialPlugin(synced.files.plugin, session.ctx, session.disposed)
      if (cleanup === null) {
        return true
      }
      session.keep(cleanup)
    } catch (error) {
      return unfinished(`official plugin ${worker.version} failed: ${reason(error)}`)
    }
    session.capturing = true
    if (session.disposed()) {
      return true
    }
  }

  if (session.useMcp && !session.mcpRegistered) {
    const { command, environment } = mcpServerCommand(
      synced.files.mcpServer,
      Bun.which('node'),
      process.execPath
    )
    try {
      const registration = await session.ctx.mcp.transform((editor) => {
        // An entry the user wrote in opencode.json wins.
        if (!editor.get(MCP_SERVER_NAME)) {
          editor.set(MCP_SERVER_NAME, {
            type: 'local',
            command,
            ...(environment ? { environment } : {}),
          })
        }
      })
      session.keep(() => registration.dispose())
      session.mcpRegistered = true
    } catch (error) {
      return unfinished(`MCP server not registered: ${reason(error)}`)
    }
  }

  if (!session.disposed()) {
    session.status.write({ state: 'ok', message: '' })
  }
  return true
}

const plugin: Plugin.Plugin = {
  id: 'opencode-claude-mem',
  setup: async (ctx) => {
    // The host also runs setup without a checkout; there is no session to serve there.
    const directory = ctx.location?.directory
    if (typeof directory !== 'string' || directory === '') {
      return
    }
    const status = captureStatusWriter(directory)
    const cleanups: Cleanup[] = []
    let disposed = false
    let wake: (() => void) | undefined = undefined
    const keep = (cleanup: Cleanup) => {
      if (disposed) {
        // Setup was torn down while this step was still running.
        void Promise.resolve()
          .then(cleanup)
          .catch(() => {})
      } else {
        cleanups.push(cleanup)
      }
    }
    const dispose = async () => {
      if (disposed) {
        return
      }
      disposed = true
      wake?.()
      status.clear()
      // Through a promise: one cleanup that throws must not skip the others.
      await Promise.allSettled(cleanups.splice(0).map((cleanup) => Promise.resolve().then(cleanup)))
    }
    const problem = (message: string) => {
      if (!disposed) {
        status.write({ state: 'problem', message: `capture off · ${message}` })
      }
    }

    try {
      // The official OpenCode plugin and these tools address the Worker by host and port.
      // With an explicit URL they would write to another store than the one configured.
      if (readWorkerSetting('CLAUDE_MEM_WORKER_URL')) {
        problem(
          'CLAUDE_MEM_WORKER_URL is not supported in OpenCode: set CLAUDE_MEM_WORKER_HOST and CLAUDE_MEM_WORKER_PORT'
        )
        return dispose
      }
      const useMcp = ctx.options['mcp'] === true
      if (!useMcp) {
        const registration = await ctx.tool.transform((editor) => {
          editor.namespace(TOOL_NAMESPACE)
          for (const tool of createWorkerTools({ directory })) {
            editor.add(tool)
          }
        })
        keep(() => registration.dispose())
      }
      const session: CaptureSession = {
        ctx,
        directory,
        status,
        useMcp,
        keep,
        disposed: () => disposed,
        capturing: false,
        mcpRegistered: false,
      }
      const attempt = (first: boolean) =>
        attemptCapture(session, first).catch((error: unknown) => {
          problem(reason(error))
          return false
        })
      const capture = (async () => {
        let finished = await attempt(true)
        for (;;) {
          if (finished || session.disposed()) {
            return
          }
          // Each pass must follow its wait; disposal ends the wait at once.
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, RETRY_INTERVAL_MS)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          if (session.disposed()) {
            return
          }
          // eslint-disable-next-line no-await-in-loop
          finished = await attempt(false)
        }
      })()
      await Promise.race([capture, Bun.sleep(SETUP_WAIT_MS)])
    } catch (error) {
      // Never throw into the host: it would drop this plugin's tools along with the error.
      problem(reason(error))
    }
    return dispose
  },
}

export default plugin
