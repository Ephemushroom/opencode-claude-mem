import { mkdtemp, rm } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const scenario = process.argv.at(2)
const configDir = await mkdtemp(join(tmpdir(), 'claude-mem-test-'))
const writes: { path: string; body: Record<string, unknown> }[] = []
let healthy = true
let contextAvailable = true
let writeStatus = 200
const sessionID = 'session-fixture'
const modelID = 'fixture-observed-model'
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/health') {
      return Response.json({ status: healthy ? 'ok' : 'offline' }, { status: healthy ? 200 : 503 })
    }
    if (path === '/api/context/inject') {
      return new Response(contextAvailable ? 'fixture-memory' : '', {
        status: contextAvailable ? 200 : 503,
      })
    }
    if (path === `/session/${sessionID}/message`) {
      return Response.json([
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'fixture-user' }] },
        {
          info: {
            id: 'assistant-fixture',
            role: 'assistant',
            modelID,
            providerID: 'fixture-provider',
          },
          parts: [{ type: 'text', text: 'fixture-assistant' }],
        },
      ])
    }
    if (request.method === 'POST') {
      const body: unknown = await request.json()
      assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body))
      writes.push({ path, body: Object.fromEntries(Object.entries(body)) })
      return Response.json({ sessionDbId: 1, promptNumber: 1 }, { status: writeStatus })
    }
    return Response.json({ content: [{ type: 'text', text: 'fixture-search' }] })
  },
})

process.env['CLAUDE_MEM_WORKER_HOST'] = '127.0.0.1'
process.env['CLAUDE_MEM_WORKER_PORT'] = String(server.port)
process.env['OPENCODE_CONFIG_DIR'] = configDir

try {
  const { ClaudeMemPlugin: createPlugin } = await import('../index')
  const { WorkerClient } = await import('../worker-client')
  // Seed the once-only startup check while online; no test can spawn a real worker.
  await WorkerClient.ensureRunning()
  const client = createOpencodeClient({ baseUrl: server.url.href })
  const hooks = await createPlugin({
    client,
    directory: configDir,
    worktree: configDir,
    project: { id: 'project-fixture', worktree: configDir, time: { created: 1 } },
    serverUrl: server.url,
    $: Bun.$,
    experimental_workspace: { register() {} },
  })

  const sendPrompt = async () => {
    assert.ok(hooks['chat.message'])
    await hooks['chat.message'](
      { sessionID, model: { providerID: 'fixture-provider', modelID } },
      {
        message: {
          id: 'user-fixture',
          sessionID,
          role: 'user',
          time: { created: 1 },
          agent: 'build',
          model: { providerID: 'fixture-provider', modelID },
        },
        parts: [
          {
            id: 'part-fixture',
            sessionID,
            messageID: 'user-fixture',
            type: 'text',
            text: 'fixture-user',
          },
        ],
      }
    )
  }

  switch (scenario) {
    case 'deleted': {
      await sendPrompt()
      assert.ok(hooks.event)
      await hooks.event({
        event: {
          type: 'session.deleted',
          properties: {
            info: {
              id: sessionID,
              projectID: 'project-fixture',
              directory: configDir,
              title: 'fixture',
              version: '1',
              time: { created: 1, updated: 1 },
            },
          },
        },
      })
      assert.equal(writes.filter((item) => item.path === '/api/sessions/complete').length, 0)
      break
    }
    case 'tool-id': {
      await sendPrompt()
      assert.ok(hooks['tool.execute.after'])
      await hooks['tool.execute.after'](
        { sessionID, callID: 'call-fixture', tool: 'read', args: { path: 'example.ts' } },
        { title: '', output: 'fixture-output', metadata: {} }
      )
      const observation = writes.find((item) => item.path === '/api/sessions/observations')
      assert.equal(observation?.body['tool_use_id'], 'call-fixture')
      break
    }
    case 'observed-model': {
      await sendPrompt()
      assert.ok(hooks.event)
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } })
      const summary = writes.find((item) => item.path === '/api/sessions/summarize')
      assert.equal(summary?.body['observedModel'], modelID)
      break
    }
    case 'offline': {
      healthy = false
      assert.equal(await WorkerClient.ensureRunning(), false)
      healthy = true
      assert.equal(await WorkerClient.ensureRunning(), true)
      break
    }
    case 'plugin-recovery': {
      healthy = false
      await sendPrompt()
      assert.equal(writes.filter((item) => item.path === '/api/sessions/init').length, 0)
      healthy = true
      await sendPrompt()
      assert.equal(writes.filter((item) => item.path === '/api/sessions/init').length, 1)
      break
    }
    case 'init-failure': {
      writeStatus = 503
      await sendPrompt()
      assert.ok(hooks['tool.execute.after'])
      await hooks['tool.execute.after'](
        { sessionID, callID: 'call-fixture', tool: 'read', args: {} },
        { title: '', output: 'fixture-output', metadata: {} }
      )
      assert.equal(writes.filter((item) => item.path === '/api/sessions/observations').length, 0)
      break
    }
    case 'summary-failure-toast': {
      await sendPrompt()
      writeStatus = 503
      assert.ok(hooks.event)
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } })
      assert.equal(writes.filter((item) => item.path === '/tui/show-toast').length, 1)
      break
    }
    case 'context-recovery': {
      await sendPrompt()
      assert.ok(hooks['experimental.session.compacting'])
      contextAvailable = false
      await hooks['experimental.session.compacting']({ sessionID }, { context: [] })
      contextAvailable = true
      const output: { context: string[] } = { context: [] }
      await hooks['experimental.session.compacting']({ sessionID }, output)
      assert.equal(output.context.length, 1)
      break
    }
    case 'write-failure': {
      writeStatus = 503
      assert.equal(await WorkerClient.summarize(sessionID, '', ''), false)
      break
    }
    default: {
      throw new Error(`Unknown fixture scenario: ${scenario}`)
    }
  }
  process.stdout.write(JSON.stringify({ scenario, passed: true }))
} finally {
  await server.stop(true)
  await rm(configDir, { recursive: true, force: true })
}
