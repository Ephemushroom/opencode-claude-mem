import { expect, test } from 'bun:test'

test.each(['render', 'offline', 'inflight-toggle', 'dispose'])(
  'CLI beta contract: %s',
  async (scenario) => {
    // Given a fresh process with the host's reactive Solid export conditions.
    const child = Bun.spawn(
      [process.execPath, '--conditions=browser', 'src/test-fixtures/cli-driver.ts', scenario],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    // When the real plugin runs against a local worker and OpenTUI test renderer.
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    // Then rendering, mouse interaction, and lifecycle assertions pass in the driver.
    expect({ code, stderr }, stdout).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain(`PASS ${scenario}`)
  },
  15000
)
