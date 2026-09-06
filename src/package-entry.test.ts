import { expect, test } from 'bun:test'
import manifest from '../package.json'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

test('imports adapters without invoking setup when either bridge is loaded', async () => {
  // Given a fresh process and isolated Worker/config boundary.
  const child = Bun.spawn([process.execPath, 'src/test-fixtures/package-driver.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // When both built bridges and legacy adapter modules are imported.
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // Then the bridges retain adapter identity without Worker requests or self-heal writes.
  expect({ code, stderr }, stdout).toEqual({ code: 0, stderr: '' })
})

test.each(['.', './server'] as const)('exposes both server contracts through %s', async (key) => {
  // Given the package export selected by a standard ESM loader.
  const entry = pathToFileURL(resolve(import.meta.dir, '..', manifest.exports[key].import)).href
  // When the published entry is imported (without invoking either adapter).
  const { default: plugin, ClaudeMemPlugin } = await import(entry)
  // Then each host can select its own contract; no TUI factory is on the server module.
  expect(plugin.id).toBe('claude-mem')
  expect(typeof plugin.server).toBe('function')
  expect(ClaudeMemPlugin).toBe(plugin.server)
  expect(typeof plugin.setup).toBe('function')
  expect(plugin.tui).toBeUndefined()
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

test('preserves explicit adapter exports when consumers use legacy paths', () => {
  // Given the shipped manifest; when legacy aliases are resolved.
  const aliases = ['./v2', './cli'] as const
  // Then they still select their original, single-runtime adapters.
  expect(aliases.map((alias) => manifest.exports[alias].import)).toEqual([
    './dist/v2.js',
    './dist/cli.js',
  ])
})
