import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeConfig } from './runtime-config'
import { serveRuntimePackage } from './runtime-package'
import { statusKey } from '../capture-status'
import { tmpdir } from 'node:os'

// Manual end-to-end check of the server part: the installed `opencode`, the packed package
// under its bare npm name, a fake Worker and model, and the real `claude-mem` release
// downloaded through the fixture registry. Nothing here touches the user's config, cache
// or memory database. Scenarios:
//   (default)  cold start downloads the official files; the warm start captures with them
//   mcp        `options.mcp` registers claude-mem's MCP server instead of the tools
//   start      no Worker on the port: the launcher is run and the Worker is awaited
//   standalone the official plugin also sits in plugins/claude-mem.js: it is not loaded twice
// The `start` scenario writes a POSIX shell launcher, so it runs on macOS and Linux only.
const scenario = process.argv[2] ?? 'capture'
const CLAUDE_MEM_VERSION = process.env.MEM_FIXTURE_CLAUDE_MEM_VERSION ?? '15.18.3'
// OpenCode 2.3 offers plugin tools through Code Mode: one catalog entry per namespace,
// called as `tools.<namespace>.<name>` inside the `execute` tool. Pinned tools are always
// listed; the rest of a namespace is found through the catalog's search.
const OWN_NAMESPACE = '- claude_mem (11 tools'
const PINNED_TOOLS = ['save_memory', 'work_state_write', 'work_state_read'].map(
  (name) => `tools.claude_mem.${name}(`
)
const OFFICIAL_TOOLS = ['search', 'timeline', 'get_observations'].map(
  (name) => `tools.claude_mem_${name}(`
)

// Resolved: OpenCode reports the checkout by its real path (macOS /var is a symlink).
const root = await realpath(await mkdtemp(join(tmpdir(), 'mem-server-runtime-')))
const pkg = await serveRuntimePackage(root)
const config = join(root, 'config', 'opencode')
const work = join(root, 'runtime-project')
const cache = join(root, 'cache', 'opencode-claude-mem')
const officialPlugin = join(cache, 'official', CLAUDE_MEM_VERSION, 'opencode-plugin.mjs')
await mkdir(config, { recursive: true })
await mkdir(work)
await mkdir(join(root, '.claude-mem'))
await writeFile(join(work, 'history.txt'), 'runtime-file-bytes')

interface Run {
  /** Each main request as sent to the model: its direct tools and its Code Mode catalog. */
  readonly requests: string[]
  readonly posts: { path: string; body: Record<string, unknown> }[]
  readonly gets: string[]
  injected: boolean
}
let run: Run = { requests: [], posts: [], gets: [], injected: false }
// Holds the first model reply until this resolves: a one-shot `opencode run` would
// otherwise finish before a cold start's download does.
let beforeFirstReply: () => Promise<void> = () => Promise.resolve()

// The status file of the running server part for this checkout; `{}` when there is none.
async function status(): Promise<{ state?: string; message?: string }> {
  try {
    const folder = join(cache, 'status')
    const files = await readdir(folder)
    const name = files.find((file) => file.startsWith(statusKey(work)) && file.endsWith('.json'))
    return name ? JSON.parse(await readFile(join(folder, name), 'utf8')) : {}
  } catch {
    return {}
  }
}

async function waitFor(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await done()) {
      return
    }
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

// The scripted model: two of this package's tools through Code Mode, then a built-in.
const SCRIPT: readonly { name: string; input: object }[] = [
  {
    name: 'execute',
    input: {
      code: 'return await tools.claude_mem.work_state_write({ list: "fixture", fields: { task: "ship", status: "todo" } })',
    },
  },
  {
    name: 'execute',
    input: {
      code: 'return await tools.claude_mem.save_memory({ text: "fixture-manual-memory", title: "Fixture note" })',
    },
  },
  { name: 'read', input: { path: join(work, 'history.txt') } },
]

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname.endsWith('/chat/completions')) {
    const body = (await request.json()) as {
      stream?: boolean
      tools?: { function: { name: string } }[]
      messages: unknown
    }
    const names = (body.tools ?? []).map((tool) => tool.function.name)
    // The title request carries no tools; only the session's own requests follow the script.
    const main = names.length > 0
    if (main) {
      if (run.requests.length === 0) {
        await beforeFirstReply()
      }
      const text = JSON.stringify(body)
      run.requests.push(text)
      run.injected ||= text.includes('fixture-runtime-memory')
    }
    const step = main ? SCRIPT[run.requests.length - 1] : undefined
    const call =
      step && names.includes(step.name)
        ? { name: step.name, arguments: JSON.stringify(step.input) }
        : undefined
    const id = `fixture-call-${run.requests.length}`
    const finish = call ? 'tool_calls' : 'stop'
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    if (!body.stream) {
      const message = call
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{ id, type: 'function', function: call }],
          }
        : { role: 'assistant', content: 'fixture-runtime-complete' }
      return Response.json({
        id: 'fixture',
        object: 'chat.completion',
        created: 1,
        model: 'model',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      })
    }
    const delta = call
      ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: call }] }
      : { role: 'assistant', content: 'fixture-runtime-complete' }
    const chunk = (payload: object) =>
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'model', ...payload })}\n\n`
    return new Response(
      [
        chunk({ choices: [{ index: 0, delta, finish_reason: null }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }),
        'data: [DONE]\n\n',
      ].join(''),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  if (request.method === 'POST') {
    const value: unknown = await request.json().catch(() => ({}))
    assert.ok(value && typeof value === 'object')
    run.posts.push({ path: url.pathname, body: Object.fromEntries(Object.entries(value)) })
    if (url.pathname === '/api/work-state/entries') {
      return new Response('Saved to "fixture". Still open: ship')
    }
    if (url.pathname === '/api/memory/save') {
      return Response.json({
        success: true,
        id: 2,
        title: 'Fixture note',
        project: 'runtime-project',
      })
    }
    return Response.json({ status: 'ok', sessionDbId: 1, promptNumber: 1 })
  }
  run.gets.push(url.pathname)
  if (url.pathname === '/api/health') {
    return Response.json({
      status: 'ok',
      version: CLAUDE_MEM_VERSION,
      initialized: true,
      mcpReady: true,
    })
  }
  if (url.pathname === '/api/context/inject') {
    return new Response('fixture-runtime-memory')
  }
  return Response.json({ status: 'ok' })
}

// `start` begins with the port closed; the launcher's log is the signal to open it.
let server: ReturnType<typeof Bun.serve> | undefined = undefined
function listen(port: number): ReturnType<typeof Bun.serve> {
  server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handle })
  return server
}
const reserved = listen(0)
const {
  port,
  url: { origin },
} = reserved
assert.ok(port, 'the fixture Worker must have a port')
if (scenario === 'start') {
  await reserved.stop(true)
  server = undefined
}
await writeFile(
  join(root, '.claude-mem', 'settings.json'),
  JSON.stringify({ CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(port) })
)

async function opencode(plugins: Parameters<typeof runtimeConfig>[1]): Promise<string> {
  run = { requests: [], posts: [], gets: [], injected: false }
  const runtime = runtimeConfig('v2', plugins, origin)
  await writeFile(join(config, 'opencode.json'), JSON.stringify(runtime.config))
  const binary = Bun.which(runtime.binary)
  assert.ok(binary, `${runtime.binary} must be installed for manual runtime QA`)
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...pkg.env,
    HOME: root,
    USERPROFILE: root,
    // OpenCode takes the session's checkout from PWD; a spawn `cwd` alone leaves the
    // parent's value in place.
    PWD: work,
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
    CLAUDE_MEM_DATA_DIR: join(root, '.claude-mem'),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_WORKER_PORT: String(port),
  }
  // Inherited when this fixture runs inside an OpenCode session: direct tool calls keep
  // the scripted model simple, and the session id must not leak into the child.
  delete env.OPENCODE_EXPERIMENTAL_CODE_MODE
  delete env.OPENCODE_SESSION_ID
  const child = Bun.spawn([binary, ...runtime.args, 'fixture-runtime-prompt'], {
    cwd: work,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  const timeout = setTimeout(() => child.kill(), 150_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    assert.equal(code, 0, stderr.slice(-3000))
    assert.ok(stdout.includes('fixture-runtime-complete'), stdout.slice(-2000))
    assert.ok(!stderr.includes('failed to load plugin'), stderr.slice(-3000))
    return stderr
  } finally {
    clearTimeout(timeout)
  }
}

const posted = (path: string) => run.posts.filter((post) => post.path === path)
const firstRequest = () => run.requests[0] ?? ''

try {
  if (scenario === 'capture') {
    // Cold: nothing on disk. The session's tools work at once; capture begins when the
    // official plugin for the Worker's version has been downloaded and verified.
    beforeFirstReply = () =>
      waitFor('the official files', async () => {
        const { state } = await status()
        return existsSync(officialPlugin) && state === 'ok'
      })
    await opencode([pkg.name])
    for (const tool of [OWN_NAMESPACE, ...PINNED_TOOLS]) {
      assert.ok(firstRequest().includes(tool), `cold start must offer ${tool}`)
    }
    assert.deepEqual(posted('/api/work-state/entries')[0]?.body, {
      cwd: work,
      list: 'fixture',
      fields: { task: 'ship', status: 'todo' },
    })
    assert.deepEqual(posted('/api/memory/save')[0]?.body, {
      text: 'fixture-manual-memory',
      title: 'Fixture note',
      cwd: work,
    })
    assert.ok(
      pkg.paths.includes(`/claude-mem/${CLAUDE_MEM_VERSION}`),
      'cold start asks the registry'
    )
    assert.ok(
      posted('/api/sessions/observations').length > 0,
      'tools after the download are captured'
    )
    const cold = { observations: posted('/api/sessions/observations').length }

    // Warm: the files are on disk, so the whole session is captured and nothing is fetched.
    beforeFirstReply = () => Promise.resolve()
    const registryRequests = pkg.paths.length
    await opencode([pkg.name])
    for (const tool of [OWN_NAMESPACE, ...PINNED_TOOLS, ...OFFICIAL_TOOLS]) {
      assert.ok(firstRequest().includes(tool), `warm start must offer ${tool}`)
      assert.equal(firstRequest().split(tool).length, 2, `${tool} is offered once`)
    }
    assert.equal(posted('/api/sessions/init').length, 1, 'the prompt is recorded once')
    assert.equal(posted('/api/sessions/init')[0]?.body['cwd'], work)
    assert.ok(run.injected, 'memory context reaches the model')
    // Code Mode reports a call twice: the outer `execute` and the tool it ran. A second
    // copy of the official plugin would show up as a repeated `Read`.
    assert.deepEqual(
      posted('/api/sessions/observations')
        .map((post) => String(post.body['tool_name']))
        .toSorted(),
      ['Read', 'claude_mem_save_memory', 'claude_mem_work_state_write', 'execute', 'execute'],
      'each tool call is recorded once'
    )
    assert.equal(posted('/api/sessions/summarize').length, 1)
    assert.ok(
      !pkg.paths.slice(registryRequests).some((path) => path.startsWith('/claude-mem')),
      'a warm start downloads nothing'
    )
    // The status belongs to a running server part: it is removed when OpenCode exits.
    assert.deepEqual(await status(), {}, 'no status is left behind')
    process.stdout.write(
      `${JSON.stringify({ passed: true, scenario, claudeMem: CLAUDE_MEM_VERSION, cold, warm: { observations: posted('/api/sessions/observations').length, injected: run.injected } })}\n`
    )
  } else if (scenario === 'mcp') {
    beforeFirstReply = () => waitFor('the official files', () => existsSync(officialPlugin))
    const stderr = await opencode([{ package: pkg.name, options: { mcp: true } }])
    const connected = /message="mcp connected" server=claude-mem tools=(\d+)/.exec(stderr)
    assert.ok(connected, stderr.slice(-3000))
    assert.ok(
      !firstRequest().includes(OWN_NAMESPACE),
      'with MCP on, the memory tools come from the MCP server only'
    )
    process.stdout.write(
      `${JSON.stringify({ passed: true, scenario, claudeMem: CLAUDE_MEM_VERSION, mcpTools: Number(connected[1]) })}\n`
    )
  } else if (scenario === 'standalone') {
    // First run: fetch the real official plugin, as a cold start does.
    beforeFirstReply = () => waitFor('the official files', () => existsSync(officialPlugin))
    await opencode([pkg.name])
    // Then install it the way `npx claude-mem install --ide opencode` does.
    await mkdir(join(config, 'plugins'))
    await copyFile(officialPlugin, join(config, 'plugins', 'claude-mem.js'))
    // The host lists its plugins only after setup, so give this package time to see it.
    beforeFirstReply = () =>
      waitFor('the standalone plugin to be confirmed', async () => {
        const { state } = await status()
        return state === 'ok'
      })
    await opencode([pkg.name])
    assert.deepEqual(
      posted('/api/sessions/observations')
        .map((post) => String(post.body['tool_name']))
        .toSorted(),
      ['Read', 'claude_mem_save_memory', 'claude_mem_work_state_write', 'execute', 'execute'],
      'the standalone plugin captures alone: nothing is recorded twice'
    )
    assert.equal(posted('/api/sessions/init').length, 1, 'the prompt is recorded once')
    assert.equal(posted('/api/sessions/summarize').length, 1)
    assert.ok(firstRequest().includes(OWN_NAMESPACE), 'this package still provides its tools')
    process.stdout.write(`${JSON.stringify({ passed: true, scenario, captures: 1 })}\n`)
  } else if (scenario === 'start') {
    // The launcher `npx claude-mem install` places; here it only records that it ran.
    const launcher = join(root, '.local', 'bin', 'claude-mem')
    const log = join(root, 'launcher.log')
    await mkdir(join(root, '.local', 'bin'), { recursive: true })
    await writeFile(launcher, `#!/bin/sh\necho "$@" >> "${log}"\n`)
    await chmod(launcher, 0o755)
    const started = waitFor('the launcher', () => existsSync(log)).then(() => listen(port))
    beforeFirstReply = () =>
      waitFor('capture', async () => {
        const { state } = await status()
        return state === 'ok'
      })
    // The model lives on the Worker port in this fixture, so OpenCode's first request
    // is retried until the Worker is up; the plugin must be what brings it up.
    await Promise.all([opencode([pkg.name]), started])
    const launched = await readFile(log, 'utf8')
    assert.equal(launched.trim(), 'start', 'the launcher runs once, with `start`')
    assert.ok(run.gets.includes('/api/health'))
    assert.ok(posted('/api/sessions/observations').length > 0, 'capture follows the Worker start')
    process.stdout.write(`${JSON.stringify({ passed: true, scenario, launcher: 'start' })}\n`)
  } else {
    throw new Error(`Unknown scenario: ${scenario}`)
  }
} finally {
  await pkg.close()
  await (server as ReturnType<typeof Bun.serve> | undefined)?.stop(true)
  if (process.env.MEM_FIXTURE_KEEP === '1') {
    process.stdout.write(`Kept ${root}\n`)
  } else {
    await rm(root, { recursive: true, force: true })
  }
}
