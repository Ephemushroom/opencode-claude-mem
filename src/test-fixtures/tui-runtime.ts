import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { driveSidebar } from './tui-screen'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runtimeConfig } from './runtime-config'
import { serveRuntimePackage } from './runtime-package'
import { tmpdir } from 'node:os'

// Installed host + packed bare package + real PTY session rendering and mouse clicks.
const root = await mkdtemp(join(tmpdir(), 'mem-tui-runtime-'))
const evidence = process.env.MEM_TUI_EVIDENCE_DIR ?? join(root, 'evidence')
const config = join(root, 'config', 'opencode')
const work = join(root, 'project')
await mkdir(config, { recursive: true })
await mkdir(work)
await mkdir(evidence, { recursive: true })
// Isolated Worker database: 7 rows for this project, while /api/stats reports 12 globally.
await mkdir(join(root, '.claude-mem'))
const db = new Database(join(root, '.claude-mem', 'claude-mem.db'))
db.run('CREATE TABLE observations (project TEXT, merged_into_project TEXT)')
db.run('CREATE TABLE session_summaries (project TEXT, merged_into_project TEXT)')
db.run('CREATE TABLE sdk_sessions (project TEXT)')
for (let i = 0; i < 7; i++) {
  db.run("INSERT INTO observations VALUES ('project', NULL)")
}
db.run("INSERT INTO observations VALUES ('elsewhere', NULL)")
db.run("INSERT INTO session_summaries VALUES ('project', NULL)")
db.run("INSERT INTO sdk_sessions VALUES ('project')")
db.close()
const pkg = await serveRuntimePackage(root)
const ready = Promise.withResolvers<void>()
let stats = 0
let stderr = ''
let modelRequests = 0
const offline = process.argv[2] === 'offline'
const worker = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path.endsWith('/chat/completions')) {
      modelRequests++
      return new Response('This sidebar fixture must not invoke models', { status: 403 })
    }
    if (path === '/api/stats') {
      stats++
      return Response.json(
        { database: { observations: 12, summaries: 2, sessions: 3 } },
        { status: offline ? 503 : 200 }
      )
    }
    const at = Date.now() - 12 * 60_000
    if (path === '/api/summaries') {
      return Response.json({
        items: [{ id: 1, request: 'project: Recent session fixture', created_at_epoch: at }],
      })
    }
    if (path === '/api/observations') {
      return Response.json({
        items: [
          { id: 2, type: 'feature', title: 'Latest observation fixture', created_at_epoch: at },
        ],
      })
    }
    if (path === '/api/observation/2') {
      return Response.json({
        id: 2,
        type: 'feature',
        title: 'Latest observation fixture',
        facts: '["Detail dialog fixture fact"]',
        created_at_epoch: at,
      })
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
  // Sidebar-only package: the server config loads no plugin; cli.json loads the sidebar.
  const runtime = runtimeConfig('v2', [], worker.url.origin)
  await writeFile(join(config, 'opencode.json'), JSON.stringify(runtime.config))
  const sidebarPath = join(config, 'cli.json')
  const navigator = join(root, 'open-session.js')
  const helper = await Bun.build({
    entrypoints: [join(import.meta.dir, 'tui-navigator.ts')],
    target: 'bun',
  })
  assert.ok(helper.success)
  const [helperOutput] = helper.outputs
  assert.ok(helperOutput)
  await writeFile(navigator, await helperOutput.text())
  const sidebar = JSON.stringify({ plugins: [pkg.name, 'mem-tui-fixture'] })
  await writeFile(sidebarPath, sidebar)
  const binary = Bun.which(runtime.binary)
  assert.ok(binary)
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'mem-tui-fixture',
      version: '1.0.0',
      type: 'module',
      files: ['open-session.js'],
      exports: { './tui': './open-session.js' },
      devDependencies: {
        'node-pty': '1.1.0',
        '@xterm/headless': '5.5.0',
      },
    })
  )
  const install = Bun.spawn([process.execPath, 'install', '--cwd', root], {
    env: { ...process.env, ...pkg.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  assert.equal(await install.exited, 0, await new Response(install.stderr).text())
  // Bun extracts node-pty's prebuilt spawn-helper without its execute bit on macOS/Linux.
  const helpers = new Bun.Glob('node_modules/node-pty/prebuilds/*/spawn-helper')
  for (const path of helpers.scanSync({ cwd: root, absolute: true })) {
    // oxlint-disable-next-line no-await-in-loop
    await chmod(path, 0o755)
  }
  const helperPack = Bun.spawn(
    [
      process.execPath,
      'pm',
      'pack',
      '--filename',
      join(root, 'helper.tgz'),
      '--ignore-scripts',
      '--quiet',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  )
  assert.equal(await helperPack.exited, 0, await new Response(helperPack.stderr).text())
  const node = Bun.which('node')
  assert.ok(node)
  const env = {
    ...process.env,
    ...pkg.env,
    TUI_FIXTURE_TOOLS: pathToFileURL(join(root, 'package.json')).href,
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
  }
  process.stdout.write(`Fixture ${root}\n`)
  child = Bun.spawn([node, join(import.meta.dir, 'tui-pty.mjs'), binary, '--standalone'], {
    cwd: work,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  const output = driveSidebar(child, evidence)
  const errors = new Response(child.stderr).text().then((text) => {
    stderr = text
  })
  const timeout = setTimeout(() => ready.reject(new Error('TUI readiness timed out')), 60000)
  try {
    await Promise.race([
      output,
      ready.promise,
      child.exited.then((code) => {
        throw new Error(`TUI exited early: ${code}`)
      }),
    ])
  } catch (error) {
    await stop()
    await Promise.allSettled([output, errors])
    throw new Error(
      `${String(error)}; stats=${stats}; ${stderr.slice(-4000)}; evidence=${evidence}; downloads=${pkg.downloads}`,
      { cause: error }
    )
  } finally {
    clearTimeout(timeout)
    await stop()
  }
  await Promise.all([child.exited, output, errors])
  assert.equal(modelRequests, 0)
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
      memoryRendered: true,
      expandedAndRecollapsed: true,
      offline,
      modelRequests,
      evidence,
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
  if (process.env.MEM_TUI_KEEP !== '1') {
    await rm(root, { recursive: true, force: true })
  }
}
