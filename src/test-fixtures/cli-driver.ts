import type { SlotClaim, Storage } from '@opencode-ai/plugin-v2/tui/context'
import { createComponent, createElement, insert, testRender } from '@opentui/solid'
import { createStore, produce } from 'solid-js/store'
import type { Context } from '@opencode-ai/plugin-v2/tui/plugin'
import { RGBA } from '@opentui/core'
import assert from 'node:assert/strict'
import { createSignal } from 'solid-js'

const scenario = process.argv[2] ?? 'render'
const held = Promise.withResolvers<void>()
const requested = Promise.withResolvers<void>()
let statsCount = 0
let observations = 12
let healthy = scenario !== 'offline'
const recentProjects: string[] = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/api/stats') {
      statsCount++
      if (statsCount === 1 && ['inflight-toggle', 'dispose'].includes(scenario)) {
        requested.resolve()
        await held.promise
      }
      return Response.json(
        { database: { observations, sessions: 3, summaries: 2 } },
        { status: healthy ? 200 : 503 }
      )
    }
    if (url.pathname === '/api/processing-status') {
      return Response.json({ queueDepth: 0, isProcessing: false })
    }
    recentProjects.push(url.searchParams.get('project') ?? '')
    return Response.json({
      items:
        url.pathname === '/api/summaries'
          ? [{ id: 1, request: 'Recent session fixture' }]
          : [{ id: 2, type: 'feature', title: 'Latest observation fixture' }],
    })
  },
})
process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1'
process.env.CLAUDE_MEM_WORKER_PORT = String(server.port)
const { default: plugin } = await import('../package-tui')
const { WorkerClient } = await import('../worker-client')
const statsFinished = Promise.withResolvers<void>()
const getStats = WorkerClient.getStats.bind(WorkerClient)
WorkerClient.getStats = async () => {
  try {
    return await getStats()
  } finally {
    statsFinished.resolve()
  }
}
const handlers = new Map<string, () => void>()
const savedHandlers: (() => void)[] = []
const [claim, setClaim] = createSignal<SlotClaim<'sidebar.content'>>()
let mutations = 0
let slotDisposals = 0
let eventDisposals = 0
let toasts = 0
let changed = Promise.withResolvers<void>()
const memory: Storage['memory'] = (_key, options) => {
  const [state, setState] = createStore(options.initial)
  return [
    state,
    (mutation) => {
      mutations++
      setState(produce(mutation))
      changed.resolve()
      changed = Promise.withResolvers<void>()
    },
  ]
}
const ui = await testRender(
  () => {
    const root = createElement('box')
    insert(root, () => {
      const current = claim()
      return current
        ? createComponent(() => current.render({ sessionID: 'fixture-session' }), {})
        : undefined
    })
    return root
  },
  { width: 60, height: 18 }
)
async function waitForFrame(predicate: (frame: string) => boolean): Promise<void> {
  const timeout = setTimeout(() => changed.reject(new Error('No matching sidebar update')), 3000)
  try {
    for (;;) {
      const next = changed.promise
      // Each captured frame must follow its corresponding store update.
      // eslint-disable-next-line no-await-in-loop
      await ui.renderOnce()
      if (predicate(ui.captureCharFrame())) {
        return
      }
      // eslint-disable-next-line no-await-in-loop
      await next
    }
  } finally {
    clearTimeout(timeout)
  }
}
// The harness supplies only used SDK facilities; accessing an omitted facility fails loudly.
function hostStub<T extends object>(properties: Partial<T>): T {
  return new Proxy(properties, {
    get(target, key, receiver) {
      assert.ok(key in target, `Unimplemented host facility: ${String(key)}`)
      return Reflect.get(target, key, receiver)
    },
  }) as T
}
const context = hostStub<Context>({
  location: { directory: 'D:/work/cli-fixture' },
  // Host-provided resolved tokens; importing the legacy theme runtime would load a second core.
  theme: hostStub<Context['theme']>({
    text: hostStub<Context['theme']['text']>({
      default: RGBA.fromHex('#eeeeee'),
      subdued: RGBA.fromHex('#888888'),
      action: hostStub<Context['theme']['text']['action']>({
        primary: hostStub<Context['theme']['text']['action']['primary']>({
          default: RGBA.fromHex('#66aaff'),
        }),
      }),
      feedback: hostStub<Context['theme']['text']['feedback']>({
        success: { default: RGBA.fromHex('#66cc88'), subdued: RGBA.fromHex('#66cc88') },
        warning: { default: RGBA.fromHex('#ddbb66'), subdued: RGBA.fromHex('#ddbb66') },
        error: { default: RGBA.fromHex('#ee6666'), subdued: RGBA.fromHex('#ee6666') },
      }),
    }),
    border: { default: RGBA.fromHex('#444444') },
  }),
  storage: hostStub<Context['storage']>({ memory }),
  data: hostStub<Context['data']>({
    on(type, handler) {
      // Events carry no fields consumed by this sidebar; the callback only invalidates stats.
      const notify = () => Reflect.apply(handler, undefined, [])
      handlers.set(type, notify)
      savedHandlers.push(notify)
      return () => {
        eventDisposals++
        handlers.delete(type)
      }
    },
  }),
  ui: hostStub<Context['ui']>({
    slot(next: SlotClaim) {
      assert.ok(next.append === 'sidebar.content')
      setClaim(() => next)
      return () => {
        slotDisposals++
        setClaim(undefined)
      }
    },
    toast: {
      show() {
        toasts++
      },
    },
  }),
})
let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
try {
  cleanup = await plugin.setup(context)
  assert.equal(typeof cleanup, 'function')
  assert.equal(handlers.size, 2)
  if (scenario === 'dispose') {
    await requested.promise
    assert.ok(cleanup)
    await cleanup()
    const before = mutations
    held.resolve()
    await statsFinished.promise
    // Let the settled stats promise's downstream continuations finish, without a timed sleep.
    await new Promise<void>((resolve) => setImmediate(resolve))
    savedHandlers.forEach((handler) => handler())
    assert.equal(mutations, before, 'disposed generation must not mutate the shared memory store')
    assert.equal(toasts, 0)
    assert.equal(slotDisposals, 1)
    assert.equal(eventDisposals, 2)
    assert.equal(statsCount, 1)
    await cleanup()
    assert.equal(slotDisposals, 1, 'cleanup is idempotent')
  } else {
    if (scenario === 'inflight-toggle') {
      await requested.promise
      await ui.renderOnce()
      await ui.mockMouse.click(3, 1)
      held.resolve()
    } else {
      await waitForFrame((frame) => frame.includes(healthy ? '12 obs' : '(offline)'))
      console.log(ui.captureCharFrame().trimEnd())
      await ui.mockMouse.click(3, 1)
    }
    await waitForFrame((frame) =>
      frame.includes(healthy ? 'Latest observation fixture' : 'worker offline')
    )
    console.log(ui.captureCharFrame().trimEnd())
    if (healthy) {
      assert.ok(recentProjects.length >= 2)
      assert.ok(recentProjects.every((project) => project === 'cli-fixture'))
      observations = 24
      handlers.get('session.execution.succeeded')?.()
      await waitForFrame((frame) => frame.includes('obs 24'))
    } else {
      assert.equal(toasts, 1)
      healthy = true
      handlers.get('session.created')?.()
      await waitForFrame((frame) => frame.includes('Latest observation fixture'))
      assert.equal(toasts, 1)
    }
    await ui.mockMouse.click(3, 1)
    await waitForFrame(
      (frame) => frame.includes('(online,') && !frame.includes('Latest observation fixture')
    )
    ui.resize(40, 18)
    await ui.renderOnce()
    assert.ok(ui.captureCharFrame().includes('Memory'))
  }
  console.log(`PASS ${scenario}`)
} finally {
  held.resolve()
  await cleanup?.()
  ui.renderer.destroy()
  await server.stop(true)
}
