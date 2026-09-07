import { expect, test } from 'bun:test'
import { parseMemoryOptions } from './memory-options'

test('normalizes string switches consistently with upstream settings', () => {
  expect(
    parseMemoryOptions({}, { CLAUDE_MEM_SEMANTIC_INJECT: ' TRUE ' }, {}).semanticInjection.enabled
  ).toBe(true)
  expect(
    parseMemoryOptions(
      {},
      { CLAUDE_MEM_SEMANTIC_INJECT: ' FALSE ' },
      { CLAUDE_MEM_SEMANTIC_INJECT: true }
    ).semanticInjection.enabled
  ).toBe(false)
})

test('uses bounded defaults when configuration is malformed', () => {
  // Given invalid plugin values and no environment overrides.
  const input = { semanticInjection: { enabled: 'yes', limit: Infinity, timeoutMs: -1 } }
  // When the configuration boundary parses it.
  const options = parseMemoryOptions(input, {}, null)
  // Then optional retrieval remains bounded and semantic retrieval opt-in.
  expect(options).toEqual({
    semanticInjection: { enabled: false, limit: 5, maxChars: 6000, timeoutMs: 2000 },
    fileContext: { enabled: true, limit: 15, maxChars: 6000, timeoutMs: 1500 },
  })
})

test('honors explicit false and limit when environment and settings disagree', () => {
  // Given three distinct precedence levels.
  const env = { CLAUDE_MEM_SEMANTIC_INJECT: 'true', CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '9' }
  const settings = { CLAUDE_MEM_SEMANTIC_INJECT: 'true', CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '2' }
  // When explicit options are supplied.
  const result = parseMemoryOptions(
    { semanticInjection: { enabled: false, limit: 7 } },
    env,
    settings
  )
  // Then explicit options win even when false.
  expect(result.semanticInjection.enabled).toBe(false)
  expect(result.semanticInjection.limit).toBe(7)
})

test('uses environment before settings when plugin options are absent', () => {
  // Given distinct environment and settings values.
  const settings = { CLAUDE_MEM_SEMANTIC_INJECT: 'true', CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '2' }
  // When an environment limit overrides the stored one.
  const result = parseMemoryOptions({}, { CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '9' }, settings)
  // Then the environment wins per field while other fields inherit settings.
  expect(result.semanticInjection.limit).toBe(9)
  expect(result.semanticInjection.enabled).toBe(true)
})
