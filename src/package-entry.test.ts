import { expect, test } from 'bun:test'
import manifest from '../package.json'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

test('imports sidebar adapters without contacting the Worker', async () => {
  // Given a fresh process and isolated Worker/config boundary.
  const child = Bun.spawn([process.execPath, 'src/test-fixtures/package-driver.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // When the built bridge and both adapter modules are imported.
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // Then the bridge retains adapter identity without Worker requests or config writes.
  expect({ code, stderr }, stdout).toEqual({ code: 0, stderr: '' })
})

test('exposes both sidebar contracts when the host selects the tui export', async () => {
  // Given the package export used by sidebar loaders.
  const entry = pathToFileURL(resolve(import.meta.dir, '..', manifest.exports['./tui'].import)).href
  // When the sidebar module is imported.
  const { default: plugin } = await import(entry)
  // Then V1 and V2 have separate factories, without a server factory.
  expect(typeof plugin.tui).toBe('function')
  expect(typeof plugin.setup).toBe('function')
  expect(plugin.server).toBeUndefined()
})

test('ships a server part under its own id, beside the sidebar', async () => {
  // Given the shipped manifest; when its exports are listed.
  const exports = Object.keys(manifest.exports)
  // Then the server entry sits beside the sidebar bridge and its legacy V2 alias.
  expect(exports).toEqual(['./server', './tui', './cli'])
  expect(manifest.exports['./cli'].import).toBe('./dist/cli.js')
  // And the server plugin does not take the official plugin's `claude-mem` id, which
  // `opencode.json` uses to disable that plugin.
  const entry = pathToFileURL(resolve(import.meta.dir, '..', manifest.exports['./server'].import))
  const { default: plugin } = await import(entry.href)
  expect(plugin.id).toBe('opencode-claude-mem')
  expect(typeof plugin.setup).toBe('function')
})
