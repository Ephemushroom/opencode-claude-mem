import {
  type WorkerStartDeps,
  autostartDisabled,
  ensureWorker,
  isConnectionRefused,
  launcherPath,
  workerState,
} from './worker-start'
import { describe, expect, test } from 'bun:test'

function deps(overrides: Partial<WorkerStartDeps>): WorkerStartDeps & { started: string[] } {
  const started: string[] = []
  return {
    probe: () => Promise.resolve(null),
    disabled: () => false,
    launcher: () => '/bin/claude-mem',
    start: (launcher) => {
      started.push(launcher)
      return Promise.resolve(true)
    },
    waitMs: 200,
    pollMs: 5,
    ...overrides,
    started,
  }
}

describe('ensureWorker', () => {
  test('leaves a Worker that answers alone', async () => {
    // Given a Worker on the port, even one that reports no version.
    const running = deps({ probe: () => Promise.resolve({ version: '15.18.3' }) })
    // When the plugin starts; then nothing is launched.
    expect(await ensureWorker(running)).toEqual({ status: 'running', version: '15.18.3' })
    expect(running.started).toEqual([])
  })

  test('runs the launcher when the port refuses, and waits for the Worker', async () => {
    // Given no Worker, and a launcher that brings one up on the third probe.
    let probes = 0
    const absent = deps({
      probe: () => Promise.resolve(++probes >= 3 ? { version: '15.18.3' } : null),
    })
    // When the plugin starts.
    const state = await ensureWorker(absent)
    // Then the launcher ran once and the Worker's version is known.
    expect(state).toEqual({ status: 'running', version: '15.18.3' })
    expect(absent.started).toEqual(['/bin/claude-mem'])
  })

  test('reports why no Worker was started', async () => {
    const notInstalled = deps({ launcher: () => null })
    const managedElsewhere = deps({ disabled: () => true })
    const neverAnswers = deps({ waitMs: 20 })
    expect(await ensureWorker(notInstalled)).toEqual({ status: 'missing' })
    expect(await ensureWorker(managedElsewhere)).toEqual({ status: 'disabled' })
    expect(await ensureWorker(neverAnswers)).toEqual({ status: 'failed' })
    expect(managedElsewhere.started).toEqual([])
    expect(neverAnswers.started).toEqual(['/bin/claude-mem'])
  })

  test('fails at once when the launcher cannot be spawned', async () => {
    // Given a launcher that is missing or blocked; when the plugin starts.
    let probes = 0
    const broken = deps({
      probe: () => {
        probes++
        return Promise.resolve(null)
      },
      start: () => Promise.resolve(false),
      waitMs: 60_000,
    })
    // Then it does not sit out the readiness wait.
    expect(await ensureWorker(broken)).toEqual({ status: 'failed' })
    expect(probes).toBe(1)
  })
})

describe('workerState', () => {
  test('looks without launching', async () => {
    const absent = deps({})
    expect(await workerState(absent)).toEqual({ status: 'failed' })
    expect(await workerState(deps({ launcher: () => null }))).toEqual({ status: 'missing' })
    expect(absent.started).toEqual([])
  })
})

describe('isConnectionRefused', () => {
  test('recognises a refusal however the runtime reports it', () => {
    const bun = Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })
    const node = new TypeError('fetch failed', {
      cause: new AggregateError(
        [Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })],
        'all attempts failed'
      ),
    })
    expect(isConnectionRefused(bun)).toBe(true)
    expect(isConnectionRefused(node)).toBe(true)
    expect(isConnectionRefused(new Error('connect ECONNREFUSED 127.0.0.1:37777'))).toBe(true)
    // A timeout or reset came from something holding the port.
    expect(isConnectionRefused(new DOMException('timed out', 'TimeoutError'))).toBe(false)
    expect(isConnectionRefused(new Error('Unable to connect'))).toBe(false)
  })
})

describe('launcherPath', () => {
  test("matches claude-mem's install location per platform", () => {
    expect(launcherPath('darwin', {}, '/Users/someone')).toBe(
      '/Users/someone/.local/bin/claude-mem'
    )
    expect(
      launcherPath('win32', { LOCALAPPDATA: String.raw`C:\Users\someone\AppData\Local` }, '')
    ).toBe(String.raw`C:\Users\someone\AppData\Local\claude-mem\bin\claude-mem.exe`)
    expect(launcherPath('win32', {}, String.raw`C:\Users\someone`)).toBe(
      String.raw`C:\Users\someone\AppData\Local\claude-mem\bin\claude-mem.exe`
    )
  })
})

describe('autostartDisabled', () => {
  const settings = (values: Record<string, string>) => (key: string) => values[key] ?? null
  test("honours claude-mem's own switches", () => {
    expect(autostartDisabled(settings({}), '127.0.0.1')).toBe(false)
    expect(autostartDisabled(settings({ CLAUDE_MEM_WORKER_AUTOSTART: 'False' }), '127.0.0.1')).toBe(
      true
    )
    expect(
      autostartDisabled(settings({ CLAUDE_MEM_WORKER_URL: 'http://host:1' }), '127.0.0.1')
    ).toBe(true)
    // A Worker on another machine cannot be started from here.
    expect(autostartDisabled(settings({}), '10.0.0.5')).toBe(true)
  })
})
