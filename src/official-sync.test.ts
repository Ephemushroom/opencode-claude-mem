import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { extractTarFiles, npmRegistry, syncOfficial } from './official-sync'
import { makeTarGz, officialTarball } from './test-fixtures/tar'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'mem-official-sync-'))
let requests = 0
// Version -> tarball; `integrity` overrides what the registry claims for it.
const releases = new Map<string, { tarball: Uint8Array; integrity?: string }>()
const registry = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    requests++
    const { pathname, origin } = new URL(request.url)
    const tarball = /^\/tarballs\/(.+)\.tgz$/.exec(pathname)
    const metadata = /^\/claude-mem\/(.+)$/.exec(pathname)
    if (metadata?.[1] === '15.77.0') {
      // A mirror that sends the metadata request elsewhere.
      return Response.redirect(`${origin}/claude-mem/15.18.3`, 302)
    }
    const release = releases.get(tarball?.[1] ?? metadata?.[1] ?? '')
    if (!release) {
      return new Response('not found', { status: 404 })
    }
    if (tarball) {
      return new Response(release.tarball)
    }
    const integrity =
      release.integrity ?? `sha512-${createHash('sha512').update(release.tarball).digest('base64')}`
    return Response.json({
      dist: { tarball: `${origin}/tarballs/${metadata?.[1]}.tgz`, integrity },
    })
  },
})
const options = (root: string) => ({ root: join(dir, root), registry: registry.url.origin })
afterAll(async () => {
  await registry.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('extractTarFiles', () => {
  test('reads the named files and skips directories and other members', () => {
    // Given a tarball with a directory, an unrelated file and a prefixed long path.
    const archive = makeTarGz([
      { name: 'package/', type: '5' },
      { name: 'package/other.js', body: 'x'.repeat(700) },
      { name: 'package/wanted.js', body: 'wanted' },
      { name: 'deep.js', prefix: 'package/a/very/long/path', body: 'deep' },
    ])
    // When two members are requested.
    const files = extractTarFiles(archive, [
      'package/wanted.js',
      'package/a/very/long/path/deep.js',
    ])
    // Then exactly those are returned, with their own bytes.
    const text = (name: string) => new TextDecoder().decode(files.get(name))
    expect([...files.keys()]).toEqual(['package/wanted.js', 'package/a/very/long/path/deep.js'])
    expect(text('package/wanted.js')).toBe('wanted')
    expect(text('package/a/very/long/path/deep.js')).toBe('deep')
  })
})

describe('syncOfficial', () => {
  test('downloads a version once and serves it from disk afterwards', async () => {
    // Given a registry with one claude-mem release.
    releases.set('15.18.3', { tarball: officialTarball('export default {}', '// mcp') })
    // When the version is synced twice.
    const first = await syncOfficial('15.18.3', options('once'))
    const before = requests
    const second = await syncOfficial('15.18.3', options('once'))
    // Then both files are stored, and the second call makes no request.
    expect(first.ok && readFileSync(first.files.plugin, 'utf8')).toBe('export default {}')
    expect(first.ok && readFileSync(first.files.mcpServer, 'utf8')).toBe('// mcp')
    expect(second).toEqual(first)
    expect(requests).toBe(before)
  })

  test('refuses a tarball that does not match the registry sha512', async () => {
    // Given a release whose registry entry lists another digest.
    releases.set('15.18.4', {
      tarball: officialTarball('export default {}', '// mcp'),
      integrity: 'sha512-AAAA',
    })
    // When it is synced.
    const result = await syncOfficial('15.18.4', options('tampered'))
    // Then nothing is stored, staging files included.
    expect(result).toEqual({ ok: false, reason: 'the tarball does not match the registry sha512' })
    expect(existsSync(join(dir, 'tampered')) ? readdirSync(join(dir, 'tampered')) : []).toEqual([])
  })

  test('reports an unknown version and a package without the OpenCode plugin', async () => {
    releases.set('15.0.0', { tarball: makeTarGz([{ name: 'package/package.json', body: '{}' }]) })
    expect(await syncOfficial('15.0.0', options('incomplete'))).toEqual({
      ok: false,
      reason: 'the package has no OpenCode plugin or MCP server',
    })
    expect(await syncOfficial('99.0.0', options('incomplete'))).toEqual({
      ok: false,
      reason: 'the registry answered HTTP 404',
    })
    // A version string never reaches the registry URL unchecked.
    const before = requests
    const rejected = await syncOfficial('../evil', options('incomplete'))
    expect(rejected.ok).toBe(false)
    expect(requests).toBe(before)
  })

  test('keeps earlier versions: another process may still run from them', async () => {
    // Given two newer releases on disk, then a Worker downgrade to an older one.
    for (const version of ['15.10.0', '15.10.1', '15.9.0']) {
      releases.set(version, { tarball: officialTarball(`// ${version}`, '// mcp') })
      // eslint-disable-next-line no-await-in-loop
      const synced = await syncOfficial(version, options('keep'))
      // Then each sync returns files that exist, the older release included.
      expect(synced.ok && readFileSync(synced.files.plugin, 'utf8')).toBe(`// ${version}`)
    }
    expect(readdirSync(join(dir, 'keep')).toSorted()).toEqual(['15.10.0', '15.10.1', '15.9.0'])
  })

  test('does not follow a redirect of the metadata request', async () => {
    // Given metadata that redirects: the digest would come from wherever it points.
    releases.set('15.18.3', { tarball: officialTarball('export default {}', '// mcp') })
    const result = await syncOfficial('15.77.0', options('redirected'))
    // Then the sync fails and nothing is stored.
    expect(result.ok).toBe(false)
    expect(existsSync(join(dir, 'redirected', '15.77.0'))).toBe(false)
  })

  test('refuses a registry or tarball over plain HTTP on another host', async () => {
    // Given a mirror that is not this machine and not HTTPS; when a version is synced.
    const before = requests
    const result = await syncOfficial('15.18.3', {
      root: join(dir, 'insecure'),
      registry: 'http://registry.example.test',
    })
    // Then nothing is requested: its metadata could name any tarball and digest.
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('insecure connection')
    expect(requests).toBe(before)
  })
})

describe('npmRegistry', () => {
  test('prefers the claude-mem override, then npm settings, then the public registry', () => {
    expect(
      npmRegistry({ CLAUDE_MEM_NPM_REGISTRY: 'http://a/', npm_config_registry: 'http://b' })
    ).toBe('http://a')
    expect(npmRegistry({ npm_config_registry: 'http://b//' })).toBe('http://b')
    expect(npmRegistry({})).toBe('https://registry.npmjs.org')
  })
})
