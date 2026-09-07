import assert from 'node:assert/strict'

export interface RuntimeEvidence {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly mainRequests: number
  readonly injected: boolean
  readonly semanticInjected: boolean
  readonly historyInjected: boolean
  readonly filePreserved: boolean
  readonly downloads: number
  readonly reads: readonly string[]
  readonly writes: readonly { readonly path: string; readonly body: Record<string, unknown> }[]
  readonly toolCatalogs: readonly string[][]
}

export function assertRuntime(evidence: RuntimeEvidence): void {
  const {
    code,
    stdout,
    stderr,
    mainRequests,
    injected,
    semanticInjected,
    historyInjected,
    filePreserved,
    downloads,
    reads,
    writes,
    toolCatalogs,
  } = evidence
  assert.equal(code, 0, `CLI exit ${code}: ${stderr.slice(-4000)} ${stdout.slice(-4000)}`)
  assert.ok(
    injected,
    `No memory injection observed: ${JSON.stringify({ mainRequests, reads, toolCatalogs })}`
  )
  assert.ok(reads.includes('/api/search'), 'native memory search must execute')
  assert.ok(
    reads.includes('/api/timeline') && reads.includes('/api/observations/batch'),
    'native three-step search must complete'
  )
  assert.equal(
    writes.filter(
      (item) => item.path === '/api/sessions/observations' && item.body.tool_use_id === 'qa-call-1'
    ).length,
    1,
    'actual tool call ID must reach Worker'
  )
  assert.ok(
    writes.some(
      (item) => item.path === '/api/sessions/summarize' && item.body.observedModel === 'model'
    ),
    'actual observed model must reach summary'
  )
  assert.ok(!writes.some((item) => item.path === '/api/sessions/complete'))
  assert.ok(semanticInjected, 'opt-in semantic context must reach actual model dispatch')
  assert.equal(writes.filter((item) => item.path === '/api/context/semantic').length, 1)
  assert.equal(writes.filter((item) => item.path === '/api/sessions/init').length, 1)
  assert.equal(
    writes.filter((item) => item.path === '/api/memory/save').length,
    1,
    'valid native save must execute once; private save must be rejected locally'
  )
  assert.ok(!writes.some((item) => JSON.stringify(item.body).includes('fixture-private-memory')))
  assert.ok(
    historyInjected && filePreserved,
    `file history and original bytes must reach model: ${JSON.stringify({ historyInjected, filePreserved, reads, readCalls: writes.filter((item) => item.body.tool_name === 'read') })}`
  )
  assert.ok(
    !writes.some(
      (item) =>
        item.path === '/api/sessions/observations' &&
        JSON.stringify(item.body).includes('fixture-file-history')
    ),
    'history must not feed back into observations'
  )
  assert.equal(downloads, 1, 'the host must install the actual packed bare package')
}
