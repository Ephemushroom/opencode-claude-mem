export function runtimeConfig(
  version: 'v1' | 'v2',
  plugins: readonly (
    | string
    | readonly [string, unknown]
    | { readonly package: string; readonly options: unknown }
  )[],
  origin: string
) {
  const model = { name: 'Fixture model', limit: { context: 32000, output: 512 } }
  const runtimes = {
    v1: {
      binary: 'opencode',
      args: [
        'run',
        '--print-logs',
        '--log-level',
        'DEBUG',
        '--model',
        'fixture/model',
        '--format',
        'json',
      ],
      helper: `export default { id: 'qa-helper', server: async () => ({ tool: { qa_echo: { description: 'Fixture echo', args: {}, async execute() { return 'fixture-echo' } } } }) }`,
      config: {
        plugin: plugins,
        model: 'fixture/model',
        provider: {
          fixture: {
            name: 'Fixture',
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: `${origin}/v1`, apiKey: 'fixture-not-a-secret' },
            models: { model },
          },
        },
        permission: 'allow',
      },
    },
    v2: {
      binary: 'opencode2',
      args: [
        'run',
        '--standalone',
        '--print-logs',
        '--log-level',
        'debug',
        '--model',
        'fixture/model',
        '--auto',
        '--format',
        'json',
      ],
      helper: `export default { id: 'qa-helper', async setup(ctx) { await ctx.tool.transform((tools) => tools.add({ name: 'qa_echo', description: 'Fixture echo', input: { type: 'object', properties: {}, additionalProperties: false }, options: { codemode: false }, async execute() { return { content: 'fixture-echo' } } })) } }`,
      config: {
        plugins,
        model: 'fixture/model',
        providers: {
          fixture: {
            name: 'Fixture',
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: { baseURL: `${origin}/v1`, apiKey: 'fixture-not-a-secret' },
            models: {
              model: { ...model, capabilities: { tools: true, input: ['text'], output: ['text'] } },
            },
          },
        },
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      },
    },
  }
  return runtimes[version]
}
