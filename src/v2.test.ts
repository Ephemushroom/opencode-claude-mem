import { expect, test } from 'bun:test'
import { join } from 'node:path'

test.each([
  'metadata',
  'recovery',
  'context-recovery',
  'resumed-location',
  'skip-tools',
  'concurrent-init',
  'dispose',
])(
  'V2 adapter: %s',
  async (scenario) => {
    // Given an isolated SDK contract harness with an actual HTTP Worker fixture.
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'test-fixtures/v2-driver.ts'), scenario],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    // When the native V2 setup, hooks, and event stream execute.
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    // Then the observed transport and lifecycle contract holds.
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual({ scenario, passed: true })
  },
  15000
)
