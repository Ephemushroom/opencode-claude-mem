import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const scenario = process.argv.at(2)
const root = await mkdtemp(join(tmpdir(), 'mem-features-'))
const requests: { path: string; query: URLSearchParams; body: Record<string, unknown> }[] = []
let status = 200
let base = 'base-1'
let semantic = 'semantic-history'
let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined = undefined
let arrived = Promise.withResolvers<void>()
let skipReason: string | undefined = undefined
let fileRows = [
  {
    id: 42,
    title: 'old-file-history',
    type: 'discovery',
    created_at_epoch: 200000,
    memory_session_id: 'mem',
    files_read: '[]',
    files_modified: '[]',
  },
]
const fileRowsByPath = new Map<string, typeof fileRows>()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const raw: unknown = request.method === 'POST' ? await request.json() : {}
    assert.ok(raw && typeof raw === 'object')
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      body: Object.fromEntries(Object.entries(raw)),
    })
    const text = base
    arrived.resolve()
    if (gate) {
      await gate.promise
    }
    if (status !== 200) {
      return new Response('', { status })
    }
    switch (url.pathname) {
      case '/api/sessions/init': {
        return Response.json({
          sessionDbId: 1,
          promptNumber: 1,
          skipped: Boolean(skipReason),
          reason: skipReason,
        })
      }
      case '/api/context/inject': {
        return new Response(text)
      }
      case '/api/context/semantic': {
        return Response.json({ context: semantic, count: 1 })
      }
      case '/api/memory/save': {
        return Response.json({
          success: true,
          id: 42,
          title: 'saved',
          project: 'fixture',
          message: 'ok',
        })
      }
      case '/api/observations/by-file': {
        const rows = fileRowsByPath.get(url.searchParams.getAll('path').at(-1) ?? '') ?? fileRows
        return Response.json({
          count: rows.length,
          observations: rows,
        })
      }
      default: {
        return Response.json({})
      }
    }
  },
})
process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1'
process.env.CLAUDE_MEM_WORKER_PORT = String(server.port)
const { MemorySessions } = await import('../memory-session')
const { MemoryWorker } = await import('../memory-worker')
const { FileContext } = await import('../file-context')
const { memoryTurn, deliveredTurn } = await import('../memory-turn')
const { parseMemoryOptions } = await import('../memory-options')
const options = parseMemoryOptions(
  { semanticInjection: { enabled: true, maxChars: 256, timeoutMs: 100 } },
  {},
  {}
)
const memory = new MemorySessions(options)
const worker = MemoryWorker
const count = (path: string) => requests.filter((r) => r.path.endsWith(path)).length
try {
  switch (scenario) {
    case 'turns': {
      // Given two different IDs with identical text, followed by a private turn.
      const first = memoryTurn('u1', 'same real user prompt repeated verbatim')
      memory.select('s', first)
      // When registration callbacks overlap and repeat across turns.
      await Promise.all([memory.register('s', 'fixture'), memory.register('s', 'fixture')])
      memory.select('s', first)
      await memory.register('s', 'fixture')
      memory.select('s', memoryTurn('u2', first.text))
      await memory.register('s', 'fixture')
      // Then the plugin submits once per ID, never alters same-text prompts.
      assert.equal(count('/init'), 2)
      assert.deepEqual(
        requests.map((r) => r.body.prompt),
        [first.text, first.text]
      )
      memory.select('s', memoryTurn('u3', '<private>secret</private>'))
      assert.equal(await memory.register('s', 'fixture'), false)
      assert.equal(memory.canCapture('s'), false)
      assert.equal(await memory.semantic('s', 'fixture'), '')
      assert.equal(count('/init'), 2)
      assert.equal(
        deliveredTurn([{ id: 'x', type: 'synthetic', text: 'internal' }])?.capture,
        false
      )
      assert.equal(memoryTurn('media', '', true).text, '[media prompt]')
      assert.equal(memoryTurn('media', '<private>secret</private>', true).capture, false)
      break
    }
    case 'retry': {
      // Given a failed first registration and a second consumed prompt.
      status = 503
      memory.select('s', memoryTurn('u1', 'first real prompt'))
      assert.equal(await memory.register('s', 'fixture'), false)
      memory.select('s', memoryTurn('u2', 'second real prompt'))
      status = 200
      // When registration recovers.
      await memory.register('s', 'fixture')
      await memory.register('s', 'fixture')
      // Then the failed prompt retries before the next one, without repeating successes.
      assert.deepEqual(
        requests.map((r) => r.body.prompt),
        ['first real prompt', 'first real prompt', 'second real prompt']
      )
      skipReason = 'private'
      memory.select('s', memoryTurn('u3', 'worker rejected prompt'))
      assert.equal(await memory.register('s', 'fixture'), false)
      skipReason = 'duplicate'
      memory.select('s', memoryTurn('u4', 'worker deduped prompt'))
      assert.equal(await memory.register('s', 'fixture'), true)
      break
    }
    case 'cache': {
      // Given an in-flight context fetch for one session.
      gate = Promise.withResolvers<void>()
      const pending = memory.context('s', 'fixture')
      await arrived.promise
      // When compaction invalidates it before it completes.
      memory.invalidate('s')
      gate.resolve()
      gate = undefined
      assert.equal(await pending, null)
      base = 'base-2'
      assert.equal(await memory.context('s', 'fixture'), 'base-2')
      base = 'base-3'
      assert.equal(await memory.context('other', 'fixture'), 'base-3')
      assert.equal(await memory.context('s', 'fixture'), 'base-2')
      memory.invalidate('s')
      status = 503
      assert.equal(await memory.context('s', 'fixture'), null)
      status = 200
      assert.equal(await memory.context('s', 'fixture'), 'base-3')
      arrived = Promise.withResolvers<void>()
      gate = Promise.withResolvers<void>()
      const deleted = memory.context('deleted', 'fixture')
      await arrived.promise
      memory.delete('deleted')
      gate.resolve()
      assert.equal(await deleted, null)
      // Late callbacks must not recreate a deleted session's cache.
      assert.equal(await memory.context('deleted', 'fixture'), null)
      break
    }
    case 'save': {
      // Given explicitly saved text with private and injected material.
      const text =
        'public <private>secret</private><claude-mem-context>recursive</claude-mem-context>'
      // When save crosses the real HTTP boundary.
      const result = JSON.parse(
        await worker.save({ text, title: 'title <private>x</private>' }, 'fixture')
      )
      // Then only sanitized content and nested attribution are transmitted.
      assert.equal(result.id, 42)
      assert.deepEqual(requests[0]?.body, {
        text: 'public',
        title: 'title',
        project: 'fixture',
        metadata: { platformSource: 'opencode' },
      })
      await worker.save({ text: '<private>secret</private>' }, 'fixture')
      await worker.save({ text: 'x'.repeat(25000) }, 'fixture')
      assert.equal(count('/save'), 1)
      status = 500
      const failure = await worker.save({ text: 'public' }, 'fixture')
      assert.equal(failure.startsWith('Memory save not confirmed.'), true)
      assert.equal(count('/save'), 2)
      break
    }
    case 'semantic': {
      // Given opt-in retrieval and an already registered real prompt.
      memory.select('s', memoryTurn('u1', 'a sufficiently long real user prompt'))
      await memory.register('s', 'fixture')
      semantic = `<private>hidden</private>${'x'.repeat(500)}`
      // When multiple model dispatches ask for semantic context.
      const results = await Promise.all([
        memory.semantic('s', 'fixture'),
        memory.semantic('s', 'fixture'),
      ])
      // Then one bounded cross-platform retrieval is reused.
      assert.deepEqual(
        results.map((r) => r.length),
        [256, 256]
      )
      assert.equal(count('/semantic'), 1)
      assert.deepEqual(requests.find((r) => r.path.endsWith('/semantic'))?.body, {
        q: 'a sufficiently long real user prompt',
        project: 'fixture',
        limit: 5,
      })
      await worker.semantic('a sufficiently long real user prompt', 'fixture', {
        ...options.semanticInjection,
        enabled: false,
      })
      assert.equal(count('/semantic'), 1)
      memory.select('s', memoryTurn('u2', 'another sufficiently long real prompt'))
      await memory.register('s', 'fixture')
      gate = Promise.withResolvers<void>()
      assert.equal(await memory.semantic('s', 'fixture'), '')
      gate.resolve()
      gate = undefined
      assert.equal(await memory.semantic('s', 'fixture'), '')
      assert.equal(count('/semantic'), 2)
      break
    }
    case 'file': {
      // Given an older large file and supplementary observations.
      const path = join(root, 'large.txt')
      await writeFile(path, 'a'.repeat(1600))
      await utimes(path, 100, 100)
      const files = new FileContext(options.fileContext, worker)
      const input = { tool: 'read', args: { filePath: path } }
      const location = { directory: root, project: 'fixture' }
      // When history is read repeatedly, then the revision is edited.
      const history = await files.read('s', input, location)
      assert.ok(history.includes('<claude-mem-context>'))
      assert.equal(await files.read('s', input, location), '')
      assert.deepEqual(requests[0]?.query.getAll('path'), [path.replaceAll('\\', '/'), 'large.txt'])
      assert.equal(requests[0]?.query.get('projects'), 'fixture')
      await utimes(path, 300, 300)
      // Then a new revision refreshes but newer file contents suppress stale history.
      assert.equal(await files.read('s', input, location), '')
      assert.equal(count('/by-file'), 2)
      break
    }
    case 'file-retry': {
      const path = join(root, 'large.txt')
      await writeFile(path, 'a'.repeat(1600))
      await utimes(path, 100, 100)
      const files = new FileContext(options.fileContext, worker)
      const input = { tool: 'read', args: { filePath: path } }
      const location = { directory: root, project: 'fixture' }
      status = 503
      assert.equal(await files.read('s', input, location), '')
      status = 200
      const recovered = await files.read('s', input, location)
      assert.ok(recovered.includes('#42'))
      assert.equal(count('/by-file'), 2)
      break
    }
    case 'file-dedupe': {
      const path = join(root, 'large.txt')
      await writeFile(path, 'a'.repeat(1600))
      await utimes(path, 100, 100)
      const [original] = fileRows
      assert.ok(original)
      fileRows = [
        original,
        { ...original, id: 43, created_at_epoch: 199999 },
        { ...original, id: 44, memory_session_id: 'other', created_at_epoch: 190000 },
      ]
      const files = new FileContext(options.fileContext, worker)
      const history = await files.read(
        's',
        { tool: 'read', args: { filePath: path } },
        { directory: root, project: 'fixture' }
      )
      assert.ok(history.includes('#42') && history.includes('#44'))
      assert.equal(history.includes('#43'), false)
      break
    }
    case 'file-budget':
    case 'file-text-budget': {
      const a = join(root, 'a.txt')
      const b = join(root, 'b.txt')
      await Promise.all([writeFile(a, 'a'.repeat(1600)), writeFile(b, 'b'.repeat(1600))])
      await Promise.all([utimes(a, 100, 100), utimes(b, 100, 100)])
      const [original] = fileRows
      assert.ok(original)
      fileRowsByPath.set('b.txt', [
        { ...original, id: 43, memory_session_id: 'other', created_at_epoch: 199999 },
      ])
      if (scenario === 'file-text-budget') {
        fileRows = [{ ...original, title: 'x'.repeat(300) }]
      }
      const budget = scenario === 'file-budget' ? { limit: 1 } : { maxChars: 256 }
      const files = new FileContext({ ...options.fileContext, ...budget }, worker)
      const location = { directory: root, project: 'fixture' }
      const first = await files.read('s', { tool: 'read', args: { filePaths: [a, b] } }, location)
      assert.ok(first.includes('#42') && !first.includes('#43'))
      const second = await files.read('s', { tool: 'read', args: { filePath: b } }, location)
      assert.ok(
        second.includes('#43'),
        'budget-excluded file history was never delivered and must remain eligible'
      )
      assert.equal(await files.read('s', { tool: 'read', args: { filePath: a } }, location), '')
      assert.equal(count('/by-file'), 3)
      break
    }
    case 'file-paths': {
      await worker.byFile(
        [String.raw`C:\work\file.ts`, String.raw`src\file.ts`],
        'fixture',
        options.fileContext
      )
      assert.deepEqual(requests[0]?.query.getAll('path'), ['C:/work/file.ts', 'src/file.ts'])
      break
    }
    default: {
      throw new Error(`Unknown scenario: ${scenario}`)
    }
  }
  process.stdout.write(JSON.stringify({ scenario, passed: true }))
} finally {
  gate?.resolve()
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
}
