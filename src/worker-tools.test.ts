import { TOOL_NAMESPACE, type WorkerTool, createWorkerTools } from './worker-tools'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface Seen {
  readonly method: string
  readonly path: string
  readonly accept: string | null
  readonly token: string | null
  readonly body: unknown
}

const seen: Seen[] = []
// Path -> what the fixture Worker answers; a function sees the request.
const routes = new Map<string, (request: Request) => Response | Promise<Response>>()
const worker = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body: unknown = request.method === 'POST' ? await request.clone().json() : null
    seen.push({
      method: request.method,
      path: url.pathname + url.search,
      accept: request.headers.get('accept'),
      token: request.headers.get('x-claude-mem-token'),
      body,
    })
    const route = routes.get(url.pathname)
    return route ? route(request) : new Response('{"error":"no such route"}', { status: 404 })
  },
})
afterAll(() => worker.stop(true))

function tools(options: Partial<Parameters<typeof createWorkerTools>[0]> = {}): WorkerTool[] {
  return createWorkerTools({
    directory: '/work/alpha',
    baseUrl: worker.url.origin,
    startWorker: () => Promise.resolve(false),
    ...options,
  })
}

async function run(
  name: string,
  input: unknown,
  from = tools(),
  signal?: AbortSignal
): Promise<string> {
  const tool = from.find((candidate) => candidate.name === name)
  if (!tool) {
    throw new Error(`no tool named ${name}`)
  }
  seen.length = 0
  const result = await tool.execute(input, signal ? { signal } : undefined)
  return result.content
}

function sse(events: readonly string[]): Response {
  return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}

describe('createWorkerTools', () => {
  test('registers the tools the official plugin leaves out, in one namespace', () => {
    // Given the default settings; when the tools are created.
    const names = tools().map((tool) => tool.name)
    // Then the set is exactly the planned one, and none repeats the official search tools.
    expect(names).toEqual([
      'save_memory',
      'work_state_write',
      'work_state_read',
      'dumb_search',
      'get_tool_uses',
      'build_corpus',
      'list_corpora',
      'prime_corpus',
      'query_corpus',
      'rebuild_corpus',
      'reprime_corpus',
    ])
    expect(tools().every((tool) => tool.options.namespace === TOOL_NAMESPACE.name)).toBe(true)
    expect(tools().every((tool) => tool.input['type'] === 'object')).toBe(true)
  })
})

describe('save_memory', () => {
  test('sends the checkout so the Worker resolves the project, and reports the saved id', async () => {
    // Given a Worker that accepts the note.
    routes.set('/api/memory/save', () =>
      Response.json({ success: true, id: 7, title: 'A note', project: 'alpha' })
    )
    // When a note is saved with an argument the route would reject.
    const text = await run('save_memory', { text: 'remember this', title: 'A note', stray: 1 })
    // Then only the route's own keys are sent, plus the checkout.
    expect(seen[0]?.body).toEqual({ text: 'remember this', title: 'A note', cwd: '/work/alpha' })
    expect(text).toBe('Saved memory #7: A note. Project: alpha.')
  })

  test('says so when the project is excluded', async () => {
    routes.set('/api/memory/save', () =>
      Response.json({ success: false, skipped: true, reason: 'project_excluded' })
    )
    expect(await run('save_memory', { text: 'x' })).toContain('excluded from claude-mem')
  })
})

describe('work state', () => {
  test('writes and reads through the checkout, returning the Worker text', async () => {
    // Given the Worker's plain-text work-state endpoints.
    routes.set('/api/work-state/entries', () => new Response('Saved to "release". Still open: 1'))
    routes.set('/api/work-state', () => new Response('- release\n  - [todo] ship'))
    // When an item is written, then the list is read with closed items.
    const fields = { task: 'ship', status: 'todo' }
    const written = await run('work_state_write', { list: 'release', fields })
    const body = seen[0]?.body
    const read = await run('work_state_read', { list: 'release', includeClosed: true })
    // Then both carry the checkout and return what the Worker said.
    expect(body).toEqual({ cwd: '/work/alpha', list: 'release', fields })
    expect(written).toBe('Saved to "release". Still open: 1')
    expect(seen[0]?.path).toBe(
      '/api/work-state?cwd=%2Fwork%2Falpha&list=release&includeClosed=true'
    )
    expect(read).toBe('- release\n  - [todo] ship')
  })

  test('shortens an oversized reply instead of flooding the context', async () => {
    routes.set('/api/work-state', () => new Response('字'.repeat(40_000)))
    const text = await run('work_state_read', {})
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(text).toContain('[Work state shortened.')
    expect(text).not.toContain('\uFFFD')
  })
})

describe('lookups', () => {
  test('dumb_search returns the Worker text content', async () => {
    routes.set('/api/dumb-search', () =>
      Response.json({ content: [{ type: 'text', text: 'dumb-search — selected details' }] })
    )
    const text = await run('dumb_search', { query: 'sidebar', limit: 2 })
    expect(seen[0]?.body).toEqual({ query: 'sidebar', limit: 2 })
    expect(text).toBe('dumb-search — selected details')
  })

  test('get_tool_uses renders stored tool I/O as a bounded tree', async () => {
    // Given raw rows whose input and response are stored as JSON strings.
    routes.set('/api/tool-uses/batch', () =>
      Response.json([
        { id: 1, tool_name: 'Read', tool_input: '{"path":"a.ts"}', tool_response: 'file text' },
      ])
    )
    // When they are fetched; then the model sees fields, not a database row.
    const text = await run('get_tool_uses', { ids: [1] })
    expect(text).toContain('Selected raw tool I/O (1 of 1).')
    expect(text).toContain('Tool #1 — Read\nInput:\npath: a.ts\nResponse:\nfile text')
  })
})

describe('corpus tools', () => {
  test('list_corpora reads the JSON the Worker wraps in text content', async () => {
    const corpora = [
      {
        name: 'auth',
        description: 'Auth work',
        stats: { observation_count: 12, token_estimate: 900 },
      },
    ]
    routes.set('/api/corpus', () =>
      Response.json({ content: [{ type: 'text', text: JSON.stringify(corpora) }] })
    )
    expect(await run('list_corpora', {})).toBe(
      'Knowledge corpora (1 of 1):\n\nauth — 12 observations; 900 estimated tokens; not primed\nAuth work'
    )
    routes.set('/api/corpus', () => Response.json({ content: [{ type: 'text', text: '[]' }] }))
    expect(await run('list_corpora', {})).toBe('No knowledge corpora found.')
  })

  test('build_corpus waits on the progress stream for the result', async () => {
    // Given a stream with keep-alive pings before the result, split across CRLF lines.
    routes.set('/api/corpus', () =>
      sse([
        ': ping\n\n',
        'event: progress\r\ndata: {"step":1}\r\n\r\n',
        'event: result\ndata: {"name":"auth","stats":{"observation_count":3,"token_estimate":40}}\n\n',
      ])
    )
    // When a corpus is built.
    const text = await run('build_corpus', { name: 'auth', project: 'alpha' })
    // Then the request asked for the stream, and the result is summarised.
    expect(seen[0]?.accept).toBe('text/event-stream')
    expect(seen[0]?.body).toEqual({ name: 'auth', project: 'alpha' })
    expect(text).toBe(
      'Corpus ready.\nauth — 3 observations; 40 estimated tokens; not primed\nUse prime_corpus before querying.'
    )
  })

  test('query_corpus addresses the corpus by name and reports a partial excerpt', async () => {
    routes.set('/api/corpus/my%20corpus/query', () =>
      Response.json({ answer: 'Because of X.', observations_sent: 5, observations_matching: 9 })
    )
    const text = await run('query_corpus', { name: 'my corpus', question: 'why?' })
    expect(seen[0]?.path).toBe('/api/corpus/my%20corpus/query')
    expect(seen[0]?.body).toEqual({ question: 'why?' })
    expect(text).toBe(
      'Corpus answer:\n\nPartial excerpt: the answer saw 5 of the 9 observations that match the question.\n\nBecause of X.'
    )
    expect(await run('query_corpus', { name: ' ', question: 'why?' })).toBe(
      'Missing required argument: name'
    )
  })

  test('reads a stream whose lines end in a bare CR, up to the very last byte', async () => {
    routes.set('/api/corpus/auth/prime', () => sse(['event: result\rdata: {"name":"auth"}\r\r']))
    expect(await run('prime_corpus', { name: 'auth' })).toBe(
      'Corpus auth primed. Use query_corpus to ask a question.'
    )
  })

  test('refuses names the URL path would resolve away', async () => {
    for (const name of ['.', '..']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run('query_corpus', { name, question: 'why?' })).toBe(
        `"${name}" is not a usable corpus name`
      )
      // eslint-disable-next-line no-await-in-loop
      expect(await run('build_corpus', { name })).toBe(`"${name}" is not a usable corpus name`)
      expect(seen).toEqual([])
    }
  })

  test('surfaces an error the Worker reports inside the stream', async () => {
    routes.set('/api/corpus/auth/prime', () =>
      sse(['event: error\ndata: {"status":409,"error":"Corpus is empty","fix":"Rebuild it"}\n\n'])
    )
    expect(await run('prime_corpus', { name: 'auth' })).toBe(
      'Worker request failed (HTTP 409).\nCorpus is empty\nRebuild it'
    )
  })

  test('gives up on a stream that goes silent', async () => {
    // Given a Worker that opens the stream and never writes again.
    routes.set('/api/corpus/auth/reprime', (request) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': ping\n\n'))
          request.signal.addEventListener('abort', () => controller.close())
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    // When the idle window passes; then the tool reports a failure instead of hanging.
    const text = await run('reprime_corpus', { name: 'auth' }, tools({ corpusIdleTimeoutMs: 50 }))
    expect(text).toBe(
      'The Worker could not complete this request. Retry after checking the Worker connection.'
    )
  })
})

describe('a Worker that requires the local API token', () => {
  test('gets the token on plain and streamed requests', async () => {
    // Given claude-mem settings with a local API token.
    const data = mkdtempSync(join(tmpdir(), 'mem-worker-tools-'))
    writeFileSync(join(data, 'settings.json'), '{"CLAUDE_MEM_LOCAL_API_TOKEN":"fixture-token"}')
    const previous = process.env.CLAUDE_MEM_DATA_DIR
    process.env.CLAUDE_MEM_DATA_DIR = data
    routes.set('/api/work-state', () => new Response('Nothing open.'))
    routes.set('/api/corpus/auth/prime', () => sse(['event: result\ndata: {"name":"auth"}\n\n']))
    try {
      // When a plain tool and a corpus tool run; then both requests carry it.
      await run('work_state_read', {})
      expect(seen[0]?.token).toBe('fixture-token')
      await run('prime_corpus', { name: 'auth' })
      expect(seen[0]?.token).toBe('fixture-token')
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_MEM_DATA_DIR
      } else {
        process.env.CLAUDE_MEM_DATA_DIR = previous
      }
      rmSync(data, { recursive: true, force: true })
    }
  })
})

describe('failures', () => {
  test("keeps the Worker's advice and drops the rest of an error body", async () => {
    routes.set('/api/memory/save', () =>
      Response.json({ error: 'text is required', stack: 'at secret/path.ts' }, { status: 400 })
    )
    expect(await run('save_memory', { text: '' })).toBe(
      'Worker request failed (HTTP 400).\ntext is required'
    )
  })

  test('drops the request when the session is stopped', async () => {
    // Given a Worker that never answers, and a session the user stops.
    routes.set('/api/work-state', () => new Promise<Response>(() => {}))
    const stop = new AbortController()
    const pending = run('work_state_read', {}, tools(), stop.signal)
    stop.abort()
    // Then the tool returns instead of waiting out its timeout.
    expect(await pending).toBe(
      'The Worker could not complete this request. Retry after checking the Worker connection.'
    )
  })

  test('starts the Worker once after a refused connection, then sends again', async () => {
    // Given a port nothing listens on.
    const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const { port } = closed
    const baseUrl = closed.url.origin
    await closed.stop(true)
    // When a tool runs with no way to start the Worker; then it says what to run.
    const down = await run('work_state_read', {}, tools({ baseUrl }))
    expect(down).toContain('npx claude-mem start')
    // And when the start brings a Worker up on that port, the same request is sent again.
    let starts = 0
    let revived: ReturnType<typeof Bun.serve> | undefined = undefined
    const startWorker = () => {
      starts++
      revived = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: () => new Response('Nothing open.'),
      })
      return Promise.resolve(true)
    }
    try {
      expect(await run('work_state_read', {}, tools({ baseUrl, startWorker }))).toBe(
        'Nothing open.'
      )
      expect(starts).toBe(1)
    } finally {
      await (revived as ReturnType<typeof Bun.serve> | undefined)?.stop(true)
    }
  })
})
