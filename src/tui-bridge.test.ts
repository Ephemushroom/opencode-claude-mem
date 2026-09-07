import { expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

test('exposes existing adapter files when the host prescans the packed TUI bridge', async () => {
  // Given the emitted bridge, using the host runtime loader's actual resolution contract.
  const bridge = pathToFileURL(resolve(import.meta.dir, '../dist/package-tui.js')).href
  const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(
    await Bun.file(new URL(bridge)).text()
  )
  expect(imports).toHaveLength(2)
  // When the host discovers transitive runtime-module imports before native package loading.
  const targets = imports.map(({ path }) => import.meta.resolve(path, bridge))
  const discovered = await Promise.all(targets.map((target) => Bun.file(new URL(target)).exists()))
  // Then neither adapter is skipped due to an extensionless, nonexistent resolved filename.
  expect(discovered).toEqual([true, true])
})
