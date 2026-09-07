import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { assertRuntime } from './runtime-assertions'
import { join } from 'node:path'
import { runtimeConfig } from './runtime-config'
import { serveRuntimePackage } from './runtime-package'
import { tmpdir } from 'node:os'
import { z } from 'zod'

// Manual end-to-end QA: installed CLI, packed bare package, isolated model and Worker.
const version = process.argv[2] === 'v1' ? 'v1' : 'v2'
const root = await mkdtemp(join(tmpdir(), 'mem-v2-runtime-'))
const pkg = await serveRuntimePackage(root)
const config = join(root, 'config', 'opencode')
const work = join(root, 'runtime-project')
await mkdir(config, { recursive: true })
await mkdir(work)
const readPath = join(work, 'history.txt')
const originalFile = 'runtime-file-bytes-'.repeat(100)
await writeFile(readPath, originalFile)
await utimes(readPath, 100, 100)
let mainRequests = 0
let injected = false
let semanticInjected = false
let historyInjected = false
let filePreserved = false
const writes: { path: string; body: Record<string, unknown> }[] = []
const reads: string[] = []
const toolCatalogs: string[][] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/chat/completions')) {
      const body = z
        .object({
          stream: z.boolean().optional(),
          tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
          messages: z.unknown(),
        })
        .parse(await request.json())
      const names = (body.tools ?? []).map((tool) => tool.function.name)
      toolCatalogs.push(names)
      const primary = names.includes('qa_echo')
      if (primary) {
        mainRequests++
        injected ||= JSON.stringify(body.messages).includes('fixture-runtime-memory')
        semanticInjected ||= JSON.stringify(body.messages).includes('fixture-semantic-memory')
        historyInjected ||= JSON.stringify(body.messages).includes('fixture-file-history')
        filePreserved ||= JSON.stringify(body.messages).includes(originalFile)
      }
      const toolName = primary
        ? [
            'qa_echo',
            'mem-search',
            'mem-timeline',
            'mem-get-observations',
            'mem-save',
            'read',
            'mem-save',
          ].at(mainRequests - 1)
        : undefined
      const toolInputs: Record<string, string> = {
        qa_echo: '{}',
        'mem-search': '{"query":"fixture"}',
        'mem-timeline': '{"anchor":1}',
        'mem-get-observations': '{"ids":[1]}',
        'mem-save':
          mainRequests === 7
            ? '{"text":"<private>fixture-private-memory</private>"}'
            : '{"text":"fixture-manual-memory"}',
        read: JSON.stringify(version === 'v1' ? { filePath: readPath } : { path: readPath }),
      }
      const message = toolName
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `qa-call-${mainRequests}`,
                type: 'function',
                function: { name: toolName, arguments: toolInputs[toolName] },
              },
            ],
          }
        : { role: 'assistant', content: 'fixture-runtime-complete' }
      const finish = toolName ? 'tool_calls' : 'stop'
      if (!body.stream) {
        return Response.json({
          id: 'qa-response',
          object: 'chat.completion',
          created: 1,
          model: 'model',
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      }
      const delta = toolName
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `qa-call-${mainRequests}`,
                type: 'function',
                function: { name: toolName, arguments: toolInputs[toolName] },
              },
            ],
          }
        : { role: 'assistant', content: 'fixture-runtime-complete' }
      const chunk = (payload: object) =>
        `data: ${JSON.stringify({ id: 'qa-response', object: 'chat.completion.chunk', created: 1, model: 'model', ...payload })}\n\n`
      return new Response(
        [
          chunk({ choices: [{ index: 0, delta, finish_reason: null }] }),
          chunk({
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
    reads.push(url.pathname)
    if (request.method === 'POST') {
      const value: unknown = await request.json()
      assert.ok(value && typeof value === 'object')
      writes.push({ path: url.pathname, body: Object.fromEntries(Object.entries(value)) })
      if (url.pathname === '/api/observations/batch') {
        return Response.json([{ id: 1, title: 'fixture-observation' }])
      }
      if (url.pathname === '/api/memory/save') {
        return Response.json({
          success: true,
          id: 2,
          title: 'fixture-manual-memory',
          project: 'runtime-project',
          message: 'saved',
        })
      }
      if (url.pathname === '/api/context/semantic') {
        return Response.json({ context: 'fixture-semantic-memory', count: 1 })
      }
      return Response.json({ sessionDbId: 1, promptNumber: 1 })
    }
    if (url.pathname === '/api/context/inject') {
      return new Response('fixture-runtime-memory')
    }
    if (url.pathname === '/api/observations/by-file') {
      return Response.json({
        count: 1,
        observations: [
          {
            id: 3,
            title: 'fixture-file-history',
            type: 'discovery',
            created_at_epoch: 200000,
            memory_session_id: 'fixture',
            files_read: '[]',
            files_modified: '[]',
          },
        ],
      })
    }
    return Response.json({
      status: 'ok',
      content: [{ type: 'text', text: 'fixture-search-result' }],
    })
  },
})
try {
  const helper = join(root, 'qa-helper')
  const options = { semanticInjection: { enabled: true } }
  const entry = version === 'v1' ? ([pkg.name, options] as const) : { package: pkg.name, options }
  const runtime = runtimeConfig(version, [entry, helper], server.url.origin)
  await mkdir(helper)
  const manifest = JSON.stringify({
    type: 'module',
    exports: { './server': './index.js', '.': './index.js' },
  })
  await writeFile(join(helper, 'package.json'), manifest)
  await writeFile(join(helper, 'index.js'), runtime.helper)
  await writeFile(join(config, 'opencode.json'), JSON.stringify(runtime.config))
  const binary = Bun.which(runtime.binary)
  assert.ok(binary, `${runtime.binary} must be installed for manual runtime QA`)
  const child = Bun.spawn([binary, ...runtime.args, 'fixture-runtime-prompt'], {
    cwd: work,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...pkg.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_CONFIG: join(config, 'opencode.json'),
      OPENCODE_CONFIG_CONTENT: '{}',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_PORT: String(server.port),
    },
  })
  const timeout = setTimeout(() => child.kill(), 90000)
  let stdout = ''
  let stderr = ''
  let code = -1
  try {
    ;[stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  } finally {
    clearTimeout(timeout)
  }
  assertRuntime({
    code,
    stdout,
    stderr,
    mainRequests,
    injected,
    semanticInjected,
    historyInjected,
    filePreserved,
    reads,
    writes,
    toolCatalogs,
    downloads: pkg.downloads,
  })
  process.stdout.write(
    JSON.stringify({
      passed: true,
      runtime: version,
      package: pkg.name,
      downloads: pkg.downloads,
      mainRequests,
      injected,
      semanticInjected,
      historyInjected,
      filePreserved,
      search: true,
      observations: writes.filter((item) => item.path.endsWith('/observations')).length,
      summaries: writes.filter((item) => item.path.endsWith('/summarize')).length,
    })
  )
} finally {
  await pkg.close()
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
}
