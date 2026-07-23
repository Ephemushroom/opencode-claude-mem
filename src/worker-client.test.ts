import { buildSearchParams, parseWorkerEndpoint } from './worker-client'
import { describe, expect, test } from 'bun:test'

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

describe('buildSearchParams', () => {
  test('forwards the complete worker search filter set', () => {
    const options = {
      query: 'TemplateEdit',
      limit: 50,
      project: 'vue-admin',
      platformSource: 'opencode',
      type: 'observations',
      obs_type: 'feature,bugfix',
      dateStart: '2026-07-17T00:00:00+08:00',
      dateEnd: '2026-07-23T23:59:59+08:00',
      offset: 20,
      orderBy: 'date_desc' as const,
    }

    const params = buildSearchParams(options)

    expect(params.toString()).toBe(
      'query=TemplateEdit&limit=50&project=vue-admin&platformSource=opencode&type=observations&obs_type=feature%2Cbugfix&dateStart=2026-07-17T00%3A00%3A00%2B08%3A00&dateEnd=2026-07-23T23%3A59%3A59%2B08%3A00&offset=20&orderBy=date_desc'
    )
  })

  test('supports date-only searches without a query', () => {
    const params = buildSearchParams({
      dateStart: '2026-07-17',
      dateEnd: '2026-07-23',
    })

    expect(params.get('query')).toBe('')
    expect(params.get('dateStart')).toBe('2026-07-17')
    expect(params.get('dateEnd')).toBe('2026-07-23')
  })

  test('omits filters that were not provided', () => {
    const params = buildSearchParams({ query: 'memory', project: 'Lark' })

    expect([...params.keys()]).toEqual(['query', 'project'])
  })
})
