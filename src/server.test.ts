import {
  type CaptureSession,
  type OfficialPluginState,
  attemptCapture,
  mcpServerCommand,
  officialPluginState,
  standalonePluginInstalled,
} from './server'
import { afterAll, describe, expect, test } from 'bun:test'
import { captureStatusWriter, readCaptureStatus } from './capture-status'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Plugin } from '@opencode/plugin'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'mem-server-'))
const setupLog = join(dir, 'official-setups.log')
// The Worker version the fixture reports; 9.9.9 is on disk, anything else must be fetched.
let workerVersion = '9.9.9'
const worker = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => Response.json({ status: 'ok', version: workerVersion }),
})
const registry = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response('unavailable', { status: 503 }),
})
// Everything the capture pass reads from the environment, pointed into the fixture.
const ENV: Record<string, string> = {
  XDG_CACHE_HOME: join(dir, 'cache'),
  OPENCODE_CONFIG_DIR: join(dir, 'opencode-config'),
  CLAUDE_MEM_DATA_DIR: join(dir, 'claude-mem-data'),
  CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
  CLAUDE_MEM_WORKER_PORT: String(worker.port),
  CLAUDE_MEM_NPM_REGISTRY: registry.url.origin,
  MEM_TEST_SETUP_LOG: setupLog,
}
const saved = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]))
Object.assign(process.env, ENV)
const official = join(dir, 'cache', 'opencode-claude-mem', 'official', '9.9.9')
mkdirSync(official, { recursive: true })
writeFileSync(join(official, 'mcp-server.cjs'), '')
// Stands in for the official plugin: each `setup` call leaves one line in the log.
writeFileSync(
  join(official, 'opencode-plugin.mjs'),
  `import { appendFileSync } from 'node:fs'
export default { id: 'claude-mem', setup() { appendFileSync(process.env.MEM_TEST_SETUP_LOG, 'setup\\n'); return () => {} } }
`
)
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await worker.stop(true)
  await registry.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

function officialSetups(): number {
  try {
    return readFileSync(setupLog, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

type McpTransform = Plugin.Context['mcp']['transform']
type McpEditor = Parameters<Parameters<McpTransform>[0]>[0]

// What the host lists for the official plugin id, as OpenCode 2.3 reports it.
const HOST_LISTS: Record<OfficialPluginState, unknown> = {
  active: { data: [{ id: 'other' }, { id: 'claude-mem', state: { status: 'active' } }] },
  failed: { data: [{ id: 'claude-mem', state: { status: 'failed', error: 'boom' } }] },
  absent: { data: [{ id: 'other', state: { status: 'active' } }] },
  unknown: { data: [] },
}

/**
 * A capture session whose host accepts MCP registrations, failing the first `failures`,
 * and lists the official plugin as `standalone`.
 */
function session(
  name: string,
  useMcp: boolean,
  failures = 0,
  standalone: OfficialPluginState = 'unknown'
) {
  const registered: unknown[] = []
  let calls = 0
  const transform: McpTransform = (callback) => {
    calls++
    if (calls <= failures) {
      return Promise.reject(new Error('host refused'))
    }
    const editor: McpEditor = {
      list: () => [],
      get: () => undefined,
      set: (_name, config) => {
        registered.push(config)
      },
      update: () => {},
      remove: () => {},
    }
    callback(editor)
    return Promise.resolve({ dispose: () => Promise.resolve() })
  }
  const directory = join(dir, name)
  mkdirSync(directory, { recursive: true })
  const capture: CaptureSession = {
    ctx: { mcp: { transform }, plugin: { list: () => Promise.resolve(HOST_LISTS[standalone]) } },
    directory,
    status: captureStatusWriter(directory),
    useMcp,
    keep: () => {},
    disposed: () => false,
    capturing: false,
    mcpRegistered: false,
  }
  return { capture, registered, directory }
}

describe('attemptCapture', () => {
  test('retries a failed MCP registration without loading the official plugin again', async () => {
    // Given a host that refuses the first MCP registration.
    workerVersion = '9.9.9'
    const { capture, registered, directory } = session('mcp-retry', true, 1)
    const before = officialSetups()
    // When the first pass runs.
    expect(await attemptCapture(capture, false)).toBe(false)
    // Then capture is on, the MCP server is not, and the sidebar is told.
    expect(officialSetups()).toBe(before + 1)
    expect({ capturing: capture.capturing, mcp: capture.mcpRegistered }).toEqual({
      capturing: true,
      mcp: false,
    })
    expect(readCaptureStatus(directory)).toEqual({
      state: 'ok',
      message: 'MCP server not registered: host refused',
    })
    // And the next pass registers the MCP server only: a second official `setup` would
    // record every prompt and tool call twice.
    expect(await attemptCapture(capture, false)).toBe(true)
    expect(officialSetups()).toBe(before + 1)
    expect(registered).toHaveLength(1)
    expect(readCaptureStatus(directory)).toEqual({ state: 'ok', message: '' })
  })

  test("waits for the Worker's exact version instead of loading another cached one", async () => {
    // Given a Worker newer than the copy on disk, and a registry that is down.
    workerVersion = '9.9.10'
    const { capture, directory } = session('exact-version', false)
    const before = officialSetups()
    // When a pass runs; then nothing is loaded and the pass stays unfinished.
    expect(await attemptCapture(capture, false)).toBe(false)
    expect(officialSetups()).toBe(before)
    expect(capture.capturing).toBe(false)
    expect(readCaptureStatus(directory)).toEqual({
      state: 'problem',
      message: 'capture off · claude-mem 9.9.10 download failed: the registry answered HTTP 503',
    })
    // And once the version is available, the same session starts capturing.
    workerVersion = '9.9.9'
    expect(await attemptCapture(capture, false)).toBe(true)
    expect(officialSetups()).toBe(before + 1)
  })

  test('leaves capture to a standalone copy the host reports as running', async () => {
    // Given the file `npx claude-mem install --ide opencode` leaves, loaded by the host.
    workerVersion = '9.9.9'
    const standalone = join(ENV['OPENCODE_CONFIG_DIR'] ?? '', 'plugins')
    mkdirSync(standalone, { recursive: true })
    writeFileSync(join(standalone, 'claude-mem.js'), '')
    const { capture } = session('standalone', false, 0, 'active')
    const before = officialSetups()
    try {
      // When a pass runs; then it counts as capturing and loads no second copy.
      expect(await attemptCapture(capture, false)).toBe(true)
      expect(capture.capturing).toBe(true)
      expect(officialSetups()).toBe(before)
      // And it needs no download: a registry that is down does not turn capture "off".
      workerVersion = '9.9.10'
      const offline = session('standalone-offline', false, 0, 'active')
      expect(await attemptCapture(offline.capture, false)).toBe(true)
      expect(readCaptureStatus(offline.directory)).toEqual({ state: 'ok', message: '' })
    } finally {
      workerVersion = '9.9.9'
      rmSync(standalone, { recursive: true, force: true })
    }
  })

  test('does not take a standalone file for capture when the host has not loaded it', async () => {
    // Given the file on disk, but a host that lists no plugin with the official id
    // (disabled in opencode.json, or not loaded for this checkout).
    workerVersion = '9.9.9'
    const standalone = join(ENV['OPENCODE_CONFIG_DIR'] ?? '', 'plugins')
    mkdirSync(standalone, { recursive: true })
    writeFileSync(join(standalone, 'claude-mem.js'), '')
    const before = officialSetups()
    try {
      // When a pass runs; then it neither claims capture nor risks a second copy.
      const unloaded = session('standalone-unloaded', false, 0, 'absent')
      expect(await attemptCapture(unloaded.capture, false)).toBe(false)
      expect(unloaded.capture.capturing).toBe(false)
      expect(officialSetups()).toBe(before)
      expect(readCaptureStatus(unloaded.directory)).toEqual({
        state: 'problem',
        message:
          'capture off · plugins/claude-mem.js is present but OpenCode has not loaded it: remove the file, or enable the claude-mem plugin',
      })
      // And a standalone copy the host reports as failed is replaced by this package's.
      const failed = session('standalone-failed', false, 0, 'failed')
      expect(await attemptCapture(failed.capture, false)).toBe(true)
      expect(officialSetups()).toBe(before + 1)
    } finally {
      rmSync(standalone, { recursive: true, force: true })
    }
  })

  test('yields to a running official plugin configured without the standalone file', async () => {
    workerVersion = '9.9.9'
    const { capture } = session('configured-elsewhere', false, 0, 'active')
    const before = officialSetups()
    expect(await attemptCapture(capture, false)).toBe(true)
    expect(officialSetups()).toBe(before)
  })

  test('reports a Worker that is not running, without starting one on a later pass', async () => {
    // Given no Worker on the configured port.
    const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const { port } = closed
    await closed.stop(true)
    process.env.CLAUDE_MEM_WORKER_PORT = String(port)
    const { capture, directory } = session('no-worker', false)
    try {
      // When a later pass runs; then it reports the problem and the port stays closed.
      expect(await attemptCapture(capture, false)).toBe(false)
      expect(readCaptureStatus(directory)?.state).toBe('problem')
      expect(readCaptureStatus(directory)?.message).toStartWith('capture off · ')
      expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow()
    } finally {
      process.env.CLAUDE_MEM_WORKER_PORT = ENV['CLAUDE_MEM_WORKER_PORT']
    }
  })
})

describe('standalonePluginInstalled', () => {
  const home = join(dir, 'home')
  const checkout = join(dir, 'checkout')
  const place = (...parts: string[]) => {
    mkdirSync(join(...parts), { recursive: true })
    writeFileSync(join(...parts, 'claude-mem.js'), '')
  }

  test('finds the official plugin file in the active OpenCode config directory', () => {
    // Given the file `npx claude-mem install` leaves, in an explicit config directory.
    const config = join(dir, 'config')
    place(config, 'plugins')
    // When that directory is the active one; then the copy is found.
    expect(standalonePluginInstalled({ OPENCODE_CONFIG_DIR: config }, home, checkout)).toBe(true)
    // And a copy in a directory OpenCode is not using does not count.
    expect(standalonePluginInstalled({}, home, checkout)).toBe(false)
    place(home, '.config', 'opencode', 'plugins')
    expect(standalonePluginInstalled({}, home, checkout)).toBe(true)
    expect(standalonePluginInstalled({ XDG_CONFIG_HOME: join(dir, 'xdg') }, home, checkout)).toBe(
      false
    )
  })

  test('finds a copy a project keeps under .opencode, in the checkout or above it', () => {
    const env = { XDG_CONFIG_HOME: join(dir, 'empty') }
    expect(standalonePluginInstalled(env, home, join(dir, 'project-a'))).toBe(false)
    place(dir, 'project-a', '.opencode', 'plugins')
    place(dir, 'project-b', '.opencode', 'plugin')
    expect(standalonePluginInstalled(env, home, join(dir, 'project-a'))).toBe(true)
    expect(standalonePluginInstalled(env, home, join(dir, 'project-b'))).toBe(true)
    expect(standalonePluginInstalled(env, home, join(dir, 'project-a', 'packages', 'web'))).toBe(
      true
    )
  })
})

describe('officialPluginState', () => {
  test('reads the host list defensively', async () => {
    const ctx = (list: () => Promise<unknown>) => ({
      mcp: { transform: () => Promise.reject(new Error('unused')) },
      plugin: { list },
    })
    for (const [state, listed] of Object.entries(HOST_LISTS)) {
      // eslint-disable-next-line no-await-in-loop
      expect(await officialPluginState(ctx(() => Promise.resolve(listed)))).toBe(
        state as OfficialPluginState
      )
    }
    expect(await officialPluginState(ctx(() => Promise.reject(new Error('down'))))).toBe('unknown')
    expect(await officialPluginState(ctx(() => Promise.resolve('garbage')))).toBe('unknown')
  })
})

describe('mcpServerCommand', () => {
  test('runs the MCP server with Node, or with the host binary as Bun', () => {
    expect(mcpServerCommand('/x/mcp-server.cjs', '/usr/bin/node', '/bin/opencode')).toEqual({
      command: ['/usr/bin/node', '/x/mcp-server.cjs'],
    })
    expect(mcpServerCommand('/x/mcp-server.cjs', null, '/bin/opencode')).toEqual({
      command: ['/bin/opencode', '/x/mcp-server.cjs'],
      environment: { BUN_BE_BUN: '1' },
    })
  })
})
