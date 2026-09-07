import assert from 'node:assert/strict'

export interface DeliveredFixture {
  messages: { type: 'user'; id: string; text: string; time: { created: number } }[]
}

export async function checkV2Memory(
  hooks: ReadonlyMap<string, (input: unknown) => Promise<void>>,
  requests: readonly { path: string; body?: Record<string, unknown> }[],
  delivered: DeliveredFixture
): Promise<void> {
  const context = hooks.get('context')
  const prompt = hooks.get('prompt')
  const tool = hooks.get('execute.after')
  assert.ok(context && prompt && tool)
  const sessionID = 'ses_fixture'
  const dispatch = () => context({ sessionID, model: { id: 'model' }, messages: [], system: [] })
  const inits = () => requests.filter((r) => r.path.endsWith('/init'))
  // Given a delivered first prompt and an admitted second identical prompt.
  await prompt({ sessionID, messageID: 'queued-user' })
  // When tool-loop context is dispatched before the second prompt is consumed.
  await Promise.all([dispatch(), dispatch()])
  // Then admission must not advance the Worker's prompt number.
  assert.equal(inits().length, 1)
  delivered.messages.push({
    type: 'user',
    id: 'queued-user',
    text: 'fixture-user',
    time: { created: 2 },
  })
  await dispatch()
  await dispatch()
  assert.deepEqual(
    inits().map((r) => r.body?.prompt),
    ['fixture-user', 'fixture-user']
  )
  delivered.messages.push({
    type: 'user',
    id: 'private-user',
    text: '<private>private turn</private>',
    time: { created: 3 },
  })
  await dispatch()
  await tool({
    sessionID,
    id: 'private-call',
    tool: 'read',
    input: {},
    status: 'completed',
    result: { content: 'private result' },
  })
  assert.equal(requests.filter((r) => r.path.endsWith('/observations')).length, 0)
  assert.equal(inits().length, 2)
}
