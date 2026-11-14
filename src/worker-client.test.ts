import {
  dataDirectory,
  defaultWorkerPort,
  isLoopbackHost,
  parseWorkerEndpoint,
  tokenHeaders,
  workerUrl,
} from './worker-client'
import { describe, expect, test } from 'bun:test'

describe('parseWorkerEndpoint', () => {
  test('returns the default endpoint when env and settings are empty', () => {
    const endpoint = parseWorkerEndpoint({}, null, 37777)

    expect(endpoint).toEqual({ host: '127.0.0.1', port: 37777 })
  })

  test('uses settings values when env is empty', () => {
    const settings = JSON.stringify({
      CLAUDE_MEM_WORKER_HOST: 'localhost',
      CLAUDE_MEM_WORKER_PORT: '40001',
    })

    const endpoint = parseWorkerEndpoint({}, settings)

    expect(endpoint).toEqual({ host: '127.0.0.1', port: 40001 })
  })

  test('prefers valid env values over settings values', () => {
    const settings = JSON.stringify({
      CLAUDE_MEM_WORKER_HOST: 'localhost',
      CLAUDE_MEM_WORKER_PORT: '40001',
    })

    const endpoint = parseWorkerEndpoint(
      { CLAUDE_MEM_WORKER_HOST: '0.0.0.0', CLAUDE_MEM_WORKER_PORT: '50002' },
      settings
    )

    expect(endpoint).toEqual({ host: '0.0.0.0', port: 50002 })
  })

  test('falls back to settings when env port is invalid', () => {
    const settings = JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '40001' })

    const endpoint = parseWorkerEndpoint({ CLAUDE_MEM_WORKER_PORT: 'abc' }, settings, 37777)

    expect(endpoint).toEqual({ host: '127.0.0.1', port: 40001 })
  })

  test('falls back to defaults when settings JSON is malformed', () => {
    const endpoint = parseWorkerEndpoint({}, '{not json', 37777)

    expect(endpoint).toEqual({ host: '127.0.0.1', port: 37777 })
  })
})

describe("claude-mem's own endpoint rules", () => {
  test('derives the unconfigured port from the user id, or the data directory on Windows', () => {
    // Given no configured port; when the default is computed as claude-mem does.
    expect(defaultWorkerPort('/home/u/.claude-mem', 'darwin', 501)).toBe(37701)
    expect(defaultWorkerPort('/home/u/.claude-mem', 'linux', 1000)).toBe(37700)
    // Then Windows, which has no user id, gets a stable port per data directory.
    const windows = defaultWorkerPort(String.raw`C:\Users\u\.claude-mem`, 'win32', null)
    expect(windows).toBeGreaterThanOrEqual(37700)
    expect(windows).toBeLessThan(37800)
    expect(defaultWorkerPort(String.raw`c:\users\U\.claude-mem`, 'win32', null)).toBe(windows)
    expect(parseWorkerEndpoint({}, null, 37701).port).toBe(37701)
  })

  test('reads settings kept under `env`, with or without a BOM', () => {
    const nested = `\uFEFF${JSON.stringify({ env: { CLAUDE_MEM_WORKER_PORT: '40002' } })}`
    expect(parseWorkerEndpoint({}, nested, 37777).port).toBe(40002)
  })

  test('accepts a port written as a JSON number, and maps localhost as claude-mem does', () => {
    const settings = JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: 40003,
      CLAUDE_MEM_WORKER_HOST: 'localhost',
    })
    expect(parseWorkerEndpoint({}, settings, 37777)).toEqual({ host: '127.0.0.1', port: 40003 })
  })

  test('finds the settings file in the configured data directory', () => {
    expect(dataDirectory({ CLAUDE_MEM_DATA_DIR: '~/mem' }, '/home/u')).toBe('/home/u/mem')
    expect(dataDirectory({}, '/home/u')).toBe('/home/u/.claude-mem')
  })

  test('brackets an IPv6 host and recognises this machine', () => {
    expect(workerUrl({ host: '::1', port: 37777 })).toBe('http://[::1]:37777')
    expect(workerUrl({ host: '127.0.0.1', port: 37777 })).toBe('http://127.0.0.1:37777')
    for (const host of ['localhost', 'dev.localhost', '::1', '[::1]', '127.0.0.1', '127.1.2.3']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    expect(isLoopbackHost('10.0.0.5')).toBe(false)
    expect(isLoopbackHost('127.example.com')).toBe(false)
  })

  test('sends the local API token to a Worker on this machine only', () => {
    // Given a Worker that requires a token on everything but its health check.
    const settings = JSON.stringify({ CLAUDE_MEM_LOCAL_API_TOKEN: ' secret ' })
    // When headers are built; then the token goes to loopback and nowhere else.
    expect(tokenHeaders('http://127.0.0.1:37777', settings)).toEqual({
      'x-claude-mem-token': 'secret',
    })
    expect(tokenHeaders('http://10.0.0.5:37777', settings)).toEqual({})
    expect(tokenHeaders('http://127.0.0.1:37777', '{}')).toEqual({})
    expect(tokenHeaders('not a url', settings)).toEqual({})
  })
})
