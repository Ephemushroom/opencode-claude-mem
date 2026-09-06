import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ensureCliPluginEntry, ensureTuiPluginEntry } from './tui-registration'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const entry = '@ephemushroom/opencode-claude-mem'
let directory = ''
let previous: string | undefined = undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cli-registration-'))
  previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = directory
})

afterEach(() => {
  if (previous === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = previous
  }
  rmSync(directory, { recursive: true, force: true })
})

test.each([
  entry,
  `${entry}@1.2.3`,
  `${entry}/cli`,
  `${entry}/cli@1.2.3`,
  `${entry}/tui`,
  { package: entry, options: { custom: true } },
  { package: `${entry}/cli`, options: { custom: true } },
])('preserves an existing CLI entry without duplicates: %j', (plugin) => {
  // Given an already configured sidebar, including the beta object form.
  const original = JSON.stringify({ plugins: [plugin], mouse: false })
  writeFileSync(join(directory, 'cli.json'), original)
  // When self-healing runs.
  const result = ensureCliPluginEntry()
  // Then the user's bytes are preserved.
  expect(result).toBe('already-present')
  expect(readFileSync(join(directory, 'cli.json'), 'utf8')).toBe(original)
})

test.each([
  '@ephemushroom/opencode-claude-mem/v2',
  { package: '@ephemushroom/opencode-claude-mem/v2', options: { custom: true } },
  '@ephemushroom/opencode-claude-mem/cli-other',
])('adds the CLI entry when another entry cannot supply it: %j', (plugin) => {
  // Given an unrelated or incorrect entry that must not be silently rewritten.
  writeFileSync(join(directory, 'cli.json'), JSON.stringify({ plugins: [plugin], mouse: false }))
  // When self-healing runs twice.
  expect(ensureCliPluginEntry()).toBe('added')
  expect(ensureCliPluginEntry()).toBe('already-present')
  // Then exactly one correct CLI entry is appended and existing settings survive.
  expect(JSON.parse(readFileSync(join(directory, 'cli.json'), 'utf8'))).toEqual({
    plugins: [plugin, entry],
    mouse: false,
  })
})

test.each([
  '{',
  '{ /* comment */ "plugins": [] }',
  '{"plugins": {}}',
  '{"plugins": null}',
  '{"plugins": [42]}',
  '{"plugins": [{"package": 42}]}',
])('leaves malformed configuration untouched: %s', (original) => {
  // Given malformed input.
  writeFileSync(join(directory, 'cli.json'), original)
  // When self-healing runs.
  const result = ensureCliPluginEntry()
  // Then it fails open without rewriting configuration.
  expect(result).toBe('malformed')
  expect(readFileSync(join(directory, 'cli.json'), 'utf8')).toBe(original)
})

test('creates a missing CLI config when called by the V2 plugin', () => {
  // Given an empty isolated config directory; when registration runs.
  expect(ensureCliPluginEntry()).toBe('added')
  // Then the bare package is registered; the host selects its sidebar export.
  expect(JSON.parse(readFileSync(join(directory, 'cli.json'), 'utf8'))).toEqual({
    plugins: [entry],
  })
})

test('preserves V1 server-driven self-heal', () => {
  // Given the shipped V1 registration form.
  const server = '@ephemushroom/opencode-claude-mem@0.5.0'
  writeFileSync(join(directory, 'opencode.json'), JSON.stringify({ plugin: [server] }))
  // When V1 registration runs.
  expect(ensureTuiPluginEntry()).toBe('added')
  // Then it still uses tui.json and the original package entry.
  expect(JSON.parse(readFileSync(join(directory, 'tui.json'), 'utf8'))).toEqual({
    plugin: [server],
  })
})
