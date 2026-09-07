import { type DeliveredFixture, checkV2Memory } from './v2-memory-checks'
import { mkdtemp, rm } from 'node:fs/promises'
import { AbsolutePath } from '@opencode-ai/schema/schema'
import type { Context } from '@opencode-ai/plugin-v2/promise/plugin'
import type { ToolEditor } from '@opencode-ai/plugin-v2/promise/tool'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type StreamEvent =
  ReturnType<Context['event']['subscribe']> extends AsyncIterable<infer E> ? E : never
const scenario = process.argv.at(2)
const configDir = await mkdtemp(join(tmpdir(), 'mem-v2-'))
const directory = '/fixture/project-a'
const sessionID = 'ses_fixture'
const delivered: DeliveredFixture = {
  messages: [{ type: 'user', id: 'user-fixture', text: 'fixture-user', time: { created: 1 } }],
}
let healthy = true
let contextAvailable = true
const requests: { path: string; project: string | null; body?: Record<string, unknown> }[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') {
      return Response.json({}, { status: healthy ? 200 : 503 })
    }
    const body: unknown = request.method === 'POST' ? await request.json() : undefined
    requests.push({
      path: url.pathname,
      project: url.searchParams.get('project'),
      ...(body && typeof body === 'object'
        ? { body: Object.fromEntries(Object.entries(body)) }
        : {}),
    })
    if (url.pathname === '/api/sessions/init') {
      return Response.json({ sessionDbId: 1, promptNumber: 1 })
    }
    if (url.pathname === '/api/context/inject') {
      return new Response(contextAvailable ? 'fixture-memory' : '', {
        status: contextAvailable ? 200 : 503,
      })
    }
    return Response.json({ content: [{ type: 'text', text: 'fixture-result' }] })
  },
})
process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1'
process.env.CLAUDE_MEM_WORKER_PORT = String(server.port)
process.env.OPENCODE_CONFIG_DIR = configDir

function hostStub<T extends object>(properties: Partial<T>): T {
  return new Proxy(properties, {
    get(target, key, receiver) {
      if (key === 'then') {
        return undefined
      }
      assert.ok(key in target, `Unimplemented host facility: ${String(key)}`)
      return Reflect.get(target, key, receiver)
    },
  }) as T
}
const hooks = new Map<string, (input: unknown) => Promise<void>>()
let wake = Promise.withResolvers<void>()
const ended = Promise.withResolvers<void>()
const events: { event: StreamEvent; done: ReturnType<typeof Promise.withResolvers<void>> }[] = []
const subscription: { signal?: AbortSignal } = {}
const ctx = hostStub<Context>({
  options: {},
  location: hostStub<Context['location']>({ directory: AbsolutePath.make(directory) }),
  session: hostStub<Context['session']>({
    async context() {
      return delivered.messages
    },
    async hook(name, callback) {
      hooks.set(name, async (input) => {
        await Reflect.apply(callback, undefined, [input])
      })
      return {
        async dispose() {
          hooks.delete(name)
        },
      }
    },
    async get(input) {
      return hostStub<Awaited<ReturnType<Context['session']['get']>>>({
        id: input.sessionID,
        location: { directory },
        model: { providerID: 'fixture-provider', id: 'fixture-model' },
      })
    },
  }),
  tool: hostStub<Context['tool']>({
    async hook(name, callback) {
      hooks.set(name, async (input) => {
        await Reflect.apply(callback, undefined, [input])
      })
      return {
        async dispose() {
          hooks.delete(name)
        },
      }
    },
    async transform(callback) {
      callback(hostStub<ToolEditor>({ add() {} }))
      return { async dispose() {} }
    },
  }),
  event: {
    async *subscribe(options) {
      subscription.signal = options?.signal
      const aborted = new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      )
      while (!options?.signal?.aborted) {
        const item = events.shift()
        if (item) {
          yield item.event
          item.done.resolve()
        } else {
          // Sequential pull models the SDK stream's backpressure.
          // eslint-disable-next-line no-await-in-loop
          const outcome = await Promise.race([
            wake.promise.then(() => true),
            ended.promise.then(() => false),
            aborted.then(() => false),
          ])
          if (!outcome) {
            return
          }
          wake = Promise.withResolvers<void>()
        }
      }
    },
  },
})
async function publish(event: StreamEvent): Promise<void> {
  const done = Promise.withResolvers<void>()
  events.push({ event, done })
  wake.resolve()
  await done.promise
}
function contextInput() {
  const system: { type: string; text: string }[] = []
  return {
    sessionID,
    agent: 'build',
    model: { providerID: 'fixture-provider', id: 'fixture-model' },
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture-user' }] }],
    tools: {},
    generation: {},
    providerOptions: {},
  }
}
const { default: plugin } = await import('../v2')
const { WorkerClient } = await import('../worker-client')
await WorkerClient.ensureRunning()
const cleanup = await plugin.setup(ctx)
const contextHook = hooks.get('context')
const toolHook = hooks.get('execute.after')
assert.ok(contextHook && toolHook && cleanup)
try {
  switch (scenario) {
    case 'memory': {
      await checkV2Memory(hooks, requests, delivered)
      await publish({
        id: 'evt_private',
        type: 'session.execution.succeeded',
        created: 0,
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: { sessionID },
      })
      assert.equal(requests.filter((r) => r.path.endsWith('/summarize')).length, 0)
      break
    }
    case 'metadata': {
      await contextHook(contextInput())
      await toolHook({
        sessionID,
        id: 'call-fixture',
        tool: 'read',
        input: {},
        status: 'completed',
        result: { content: 'output' },
      })
      await publish({
        id: 'evt_fixture',
        type: 'session.execution.succeeded',
        created: 0,
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: { sessionID },
      })
      assert.equal(
        requests.find((r) => r.path.endsWith('/observations'))?.body?.['tool_use_id'],
        'call-fixture'
      )
      assert.equal(
        requests.find((r) => r.path.endsWith('/summarize'))?.body?.['observedModel'],
        'fixture-model'
      )
      break
    }
    case 'recovery': {
      healthy = false
      await contextHook(contextInput())
      healthy = true
      const input = contextInput()
      await contextHook(input)
      assert.equal(input.system.length, 1)
      break
    }
    case 'context-recovery': {
      contextAvailable = false
      await contextHook(contextInput())
      contextAvailable = true
      const input = contextInput()
      await contextHook(input)
      assert.equal(input.system.length, 1)
      break
    }
    case 'resumed-location': {
      await contextHook(contextInput())
      assert.equal(requests.find((r) => r.path.endsWith('/init'))?.body?.['project'], 'project-a')
      assert.equal(requests.find((r) => r.path.endsWith('/inject'))?.project, 'project-a')
      break
    }
    case 'skip-tools': {
      await contextHook(contextInput())
      await Promise.all(
        ['mem_search', 'mem_timeline', 'mem_get_observations'].map((tool) =>
          toolHook({
            sessionID,
            id: 'call-fixture',
            tool,
            input: {},
            status: 'completed',
            result: { content: 'memory' },
          })
        )
      )
      assert.equal(requests.filter((r) => r.path.endsWith('/observations')).length, 0)
      break
    }
    case 'concurrent-init': {
      await Promise.all([contextHook(contextInput()), contextHook(contextInput())])
      assert.equal(requests.filter((r) => r.path.endsWith('/init')).length, 1)
      break
    }
    case 'dispose': {
      await cleanup()
      assert.equal(subscription.signal?.aborted, true)
      break
    }
    default: {
      throw new Error(`Unknown scenario: ${scenario}`)
    }
  }
  process.stdout.write(JSON.stringify({ scenario, passed: true }))
} finally {
  ended.resolve()
  await cleanup()
  await server.stop(true)
  await rm(configDir, { recursive: true, force: true })
}
