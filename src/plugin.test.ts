import { expect, test } from 'bun:test'
import { join } from 'node:path'

for (const scenario of [
  'deleted',
  'turns-private',
  'assistant-transition',
  'assistant-repeat',
  'tool-id',
  'observed-model',
  'offline',
  'plugin-recovery',
  'init-failure',
  'summary-failure-toast',
  'context-recovery',
  'write-failure',
]) {
  test(`V1 ${scenario} respects the Worker contract`, async () => {
    // Given an isolated plugin process with a real HTTP fixture, not the user's Worker.
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'test-fixtures/v1-driver.ts'), scenario],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    // When the scenario drives the public plugin hooks / Worker client.
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    // Then its observable HTTP behavior must satisfy the contract.
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual({ scenario, passed: true })
  })
}
