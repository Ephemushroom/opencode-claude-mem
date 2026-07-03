import { describe, expect, test } from 'bun:test'
import { parseWorkerEndpoint } from './worker-client'

describe('parseWorkerEndpoint', () => {
  test('returns the default endpoint when env and settings are empty', () => {
    const endpoint = parseWorkerEndpoint({}, null)

    expect(endpoint).toEqual({ host: '127.0.0.1', port: 37777 })
  })

  test('uses settings values when env is empty', () => {
    const settings = JSON.stringify({
      CLAUDE_MEM_WORKER_HOST: 'localhost',
      CLAUDE_MEM_WORKER_PORT: '40001',
    })

    const endpoint = parseWorkerEndpoint({}, settings)

    expect(endpoint).toEqual({ host: 'localhost', port: 40001 })
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

    const endpoint = parseWorkerEndpoint({ CLAUDE_MEM_WORKER_PORT: 'abc' }, settings)

    expect(endpoint).toEqual({ host: '127.0.0.1', port: 40001 })
  })

  test('falls back to defaults when settings JSON is malformed', () => {
    const endpoint = parseWorkerEndpoint({}, '{not json')

    expect(endpoint).toEqual({ host: '127.0.0.1', port: 37777 })
  })
})
