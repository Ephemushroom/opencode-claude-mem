import { expect, test } from 'bun:test'
import { shouldSkipObservationTool, stripTaggedContent } from './shared'
import { join } from 'node:path'
import { memoryTurn } from './memory-turn'

test('retrieves semantic context for a real text prompt even when files are attached', () => {
  const turn = memoryTurn(
    'with-file',
    'Explain the earlier decision about this attached file',
    true
  )
  expect(turn.capture).toBe(true)
  expect(turn.semantic).toBe(true)
  expect(memoryTurn('file-only', '', true).semantic).toBe(false)
})

test.each([
  'public <PRIVATE>secret</PRIVATE>',
  'public <private>secret',
  'public <private>outer <private>inner</private> secret</private>',
  'public <claude-mem-context source="history">recursive</claude-mem-context>',
])('removes protected material when tags are nested or malformed: %s', (text) => {
  // Given protected payloads at a capture/save boundary.
  // When tags are sanitized.
  const result = stripTaggedContent(text)
  // Then none of the protected bytes are retained.
  expect(result).toBe('public')
})

test.each(['mem-save', 'mem_save', 'functions.mem_save', 'worker_mem-save'])(
  'skips manual memory writes when tool name is %s',
  (name) => {
    // Given a native or namespaced manual memory tool.
    // When observation routing classifies the tool.
    const skipped = shouldSkipObservationTool(name)
    // Then saved memories cannot feed back into automatic capture.
    expect(skipped).toBe(true)
  }
)

test.each([
  'turns',
  'retry',
  'cache',
  'save',
  'semantic',
  'file',
  'file-retry',
  'file-dedupe',
  'file-paths',
  'file-budget',
  'file-text-budget',
])(
  'shared memory HTTP contract: %s',
  async (scenario) => {
    // Given an isolated real HTTP Worker fixture.
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'test-fixtures/memory-driver.ts'), scenario],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    // When shared memory behavior runs through its transport.
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    // Then every observable contract assertion holds.
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual({ scenario, passed: true })
  },
  15000
)
