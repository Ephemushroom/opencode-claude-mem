import { build } from 'bun'

// The host prescans package imports with import.meta.resolve, which does not add .js.
// Preserve separate adapter identities while making every bridge edge discoverable.
const result = await build({
  entrypoints: ['src/package-tui.ts'],
  outdir: 'dist',
  target: 'bun',
  format: 'esm',
  plugins: [
    {
      name: 'explicit-tui-adapter-extensions',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^\.\/(cli|tui)$/ }, ({ path }) => ({
          path: `${path}.js`,
          external: true,
        }))
      },
    },
  ],
})
if (!result.success) {
  throw new AggregateError(result.logs, 'TUI bridge build failed')
}
