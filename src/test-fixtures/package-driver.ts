import { join, resolve } from 'node:path'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import assert from 'node:assert/strict'
import manifest from '../../package.json'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const config = await mkdtemp(join(tmpdir(), 'mem-package-import-'))
let requests = 0
const worker = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    requests++
    return Response.json({ status: 'ok' })
  },
})
process.env.OPENCODE_CONFIG_DIR = config
process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1'
process.env.CLAUDE_MEM_WORKER_PORT = String(worker.port)
try {
  const load = (entry: string) =>
    import(pathToFileURL(resolve(import.meta.dir, '../..', entry)).href)
  const [sidebar, tui, cli] = await Promise.all([
    load(manifest.exports['./tui'].import),
    load('./dist/tui.js'),
    load('./dist/cli.js'),
  ])
  assert.equal(sidebar.default.tui, tui.default.tui)
  assert.equal(sidebar.default.setup, cli.default.setup)
  assert.equal(requests, 0, 'importing the bridge must not contact the Worker')
  assert.deepEqual(await readdir(config), [], 'importing must not write configuration')
  process.stdout.write('PASS package-import')
} finally {
  await worker.stop(true)
  await rm(config, { recursive: true, force: true })
}
