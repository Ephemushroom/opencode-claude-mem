import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runtimeConfig } from './runtime-config'
import { serveRuntimePackage } from './runtime-package'
import { tmpdir } from 'node:os'

// Whole-host sidebar loading probe. A piped terminal cannot prove on-screen layout;
// cli-driver separately exercises the bridge's real OpenTUI rendering and clicks.
const root = await mkdtemp(join(tmpdir(), 'mem-tui-runtime-'))
const config = join(root, 'config', 'opencode')
const work = join(root, 'project')
await mkdir(config, { recursive: true })
await mkdir(work)
const pkg = await serveRuntimePackage(root)
const ready = Promise.withResolvers<void>()
let stats = 0
let stdout = ''
let stderr = ''
const worker = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/stats') {
      stats++
      ready.resolve()
      return Response.json({ database: { observations: 12, summaries: 2, sessions: 3 } })
    }
    if (path === '/api/context/inject') {
      return new Response('fixture-tui-memory')
    }
    return Response.json({
      status: 'ok',
      sessionDbId: 1,
      promptNumber: 1,
      queueDepth: 0,
      isProcessing: false,
    })
  },
})
let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined = undefined
let stopped = false
const stop = async () => {
  if (!child || stopped) {
    return
  }
  stopped = true
  if (process.platform === 'win32') {
    // Installed Windows commands are shims: terminate only this fixture's process tree.
    await Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited
  } else {
    child.kill()
  }
}
try {
  const runtime = runtimeConfig('v2', [pkg.name], worker.url.origin)
  await writeFile(join(config, 'opencode.json'), JSON.stringify(runtime.config))
  const sidebarPath = join(config, 'cli.json')
  const sidebar = JSON.stringify({ plugins: [pkg.name] })
  await writeFile(sidebarPath, sidebar)
  const binary = Bun.which(runtime.binary)
  assert.ok(binary)
  child = Bun.spawn([binary, '--standalone'], {
    cwd: work,
    stdin: 'pipe',
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
      CLAUDE_MEM_WORKER_PORT: String(worker.port),
      TERM: 'xterm-256color',
      COLUMNS: '140',
      LINES: '40',
    },
  })
  const output = new Response(child.stdout).text().then((text) => {
    stdout = text
  })
  const errors = new Response(child.stderr).text().then((text) => {
    stderr = text
  })
  const timeout = setTimeout(() => ready.reject(new Error('TUI readiness timed out')), 60000)
  try {
    await Promise.race([
      ready.promise,
      child.exited.then((code) => {
        throw new Error(`TUI exited early: ${code}`)
      }),
    ])
  } catch (error) {
    await stop()
    await Promise.all([output, errors])
    throw new Error(
      `${String(error)}; stats=${stats}; ${stderr.slice(-4000)}; ${Bun.stripANSI(stdout).slice(0, 6000)}`,
      { cause: error }
    )
  } finally {
    clearTimeout(timeout)
    await stop()
  }
  await Promise.all([child.exited, output, errors])
  assert.equal(
    await readFile(sidebarPath, 'utf8'),
    sidebar,
    'bare registration must not append a duplicate alias'
  )
  process.stdout.write(
    JSON.stringify({
      passed: true,
      runtime: 'v2',
      package: pkg.name,
      sidebarLoaded: true,
      memoryRendered: stdout.includes('Memory'),
      stats,
      downloads: pkg.downloads,
    })
  )
} finally {
  await stop()
  if (child) {
    await child.exited
  }
  await worker.stop(true)
  await pkg.close()
  await rm(root, { recursive: true, force: true })
}
