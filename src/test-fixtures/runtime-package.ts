import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import manifest from '../../package.json'

// Serve the actual pack artifact under its bare npm name, never the published old release.
export async function serveRuntimePackage(root: string) {
  const archive = join(root, 'plugin.tgz')
  const pack = Bun.spawn(
    [process.execPath, 'pm', 'pack', '--filename', archive, '--ignore-scripts', '--quiet'],
    { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' }
  )
  const [code, stderr] = await Promise.all([pack.exited, new Response(pack.stderr).text()])
  assert.equal(code, 0, stderr)
  let downloads = 0
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname)
      if (path === '/plugin.tgz') {
        downloads++
        return new Response(Bun.file(archive))
      }
      if (path === `/${manifest.name}` || path.startsWith(`/${manifest.name}/`)) {
        const version = { ...manifest, dist: { tarball: `${url.origin}/plugin.tgz` } }
        return Response.json(
          path === `/${manifest.name}`
            ? {
                name: manifest.name,
                'dist-tags': { latest: manifest.version },
                versions: { [manifest.version]: version },
              }
            : version
        )
      }
      const response = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, {
        signal: AbortSignal.timeout(30000),
      })
      // Bun decompresses fetch bodies; forwarding Content-Encoding would decode twice.
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
      })
    },
  })
  const { origin } = registry.url
  return {
    name: manifest.name,
    env: {
      npm_config_registry: origin,
      NPM_CONFIG_REGISTRY: origin,
      BUN_INSTALL_CACHE_DIR: join(root, 'bun-cache'),
    },
    get downloads() {
      return downloads
    },
    close: () => registry.stop(true),
  }
}
