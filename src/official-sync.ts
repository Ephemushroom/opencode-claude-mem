/**
 * Keeps a copy of the official claude-mem OpenCode plugin and MCP server at the version of
 * the running Worker. Both come from the `claude-mem` npm tarball of that exact version,
 * checked against the registry's sha512, so this package never carries capture code of its
 * own that could drift from the Worker's API.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isLoopbackHost, isRecord } from './worker-client'
import { cacheDirectory } from './capture-status'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const METADATA_TIMEOUT_MS = 15_000
const TARBALL_TIMEOUT_MS = 120_000
const TAR_BLOCK = 512
// Tarball member -> file name in the version directory. `.mjs`: the bundle is an ES module.
const PLUGIN_MEMBER = 'package/dist/opencode-plugin/index.js'
const PLUGIN_FILE = 'opencode-plugin.mjs'
const MCP_MEMBER = 'package/plugin/scripts/mcp-server.cjs'
const MCP_FILE = 'mcp-server.cjs'

export interface OfficialFiles {
  readonly version: string
  /** The official OpenCode plugin: default export `{ id, server, setup }`. */
  readonly plugin: string
  readonly mcpServer: string
}

export type SyncResult =
  | { readonly ok: true; readonly files: OfficialFiles }
  | { readonly ok: false; readonly reason: string }

export interface SyncOptions {
  /** Directory holding one sub-directory per version. */
  readonly root?: string
  readonly registry?: string
}

export function officialRoot(): string {
  return join(cacheDirectory(), 'official')
}

/** `CLAUDE_MEM_NPM_REGISTRY`, then npm's own registry setting, then the public registry. */
export function npmRegistry(env: Record<string, string | undefined> = process.env): string {
  const configured =
    env['CLAUDE_MEM_NPM_REGISTRY']?.trim() ||
    env['npm_config_registry']?.trim() ||
    env['NPM_CONFIG_REGISTRY']?.trim() ||
    DEFAULT_REGISTRY
  return configured.replace(/\/+$/, '')
}

function headerText(header: Uint8Array, start: number, length: number): string {
  const field = header.subarray(start, start + length)
  const end = field.indexOf(0)
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end))
}

/**
 * Reads the named regular files out of a gzipped tar. npm tarballs are ustar; a path longer
 * than the name field uses the prefix field, and anything else (pax records, directories)
 * is skipped by its size. No `tar` binary is needed, which Windows may not have on PATH.
 */
export function extractTarFiles(
  archive: Uint8Array,
  members: readonly string[]
): Map<string, Uint8Array> {
  const tar = gunzipSync(archive)
  const found = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + TAR_BLOCK <= tar.length && found.size < members.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    if (header.every((byte) => byte === 0)) {
      break
    }
    // A size that is not plain octal means a header this reader does not understand.
    const sizeText = headerText(header, 124, 12).trim()
    if (!/^[0-7]*$/.test(sizeText)) {
      break
    }
    const size = Number.parseInt(sizeText || '0', 8)
    const prefix = headerText(header, 345, 155)
    const name = prefix ? `${prefix}/${headerText(header, 0, 100)}` : headerText(header, 0, 100)
    const body = offset + TAR_BLOCK
    // Type flag '0' or NUL marks a regular file.
    const regular = header[156] === 48 || header[156] === 0
    if (regular && members.includes(name) && body + size <= tar.length) {
      found.set(name, tar.subarray(body, body + size))
    }
    offset = body + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return found
}

function filesFor(root: string, version: string): OfficialFiles | null {
  const dir = join(root, version)
  const files = { version, plugin: join(dir, PLUGIN_FILE), mcpServer: join(dir, MCP_FILE) }
  return existsSync(files.plugin) && existsSync(files.mcpServer) ? files : null
}

/**
 * The registry names the tarball and its digest together, so the sha512 check is only as
 * good as the transport: plain HTTP is accepted from this machine alone.
 */
function assertSecure(url: string): void {
  const { protocol, hostname } = new URL(url)
  if (protocol !== 'https:' && !(protocol === 'http:' && isLoopbackHost(hostname))) {
    throw new Error(`refusing to download over an insecure connection: ${url}`)
  }
}

async function fetchJson(url: string): Promise<unknown> {
  assertSecure(url)
  // No redirects: the metadata carries the digest, so every hop would have to be secure.
  const response = await fetch(url, {
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(`the registry answered HTTP ${response.status}`)
  }
  return response.json()
}

async function download(root: string, version: string, registry: string): Promise<OfficialFiles> {
  const metadata = await fetchJson(`${registry}/claude-mem/${version}`)
  const dist = isRecord(metadata) && isRecord(metadata['dist']) ? metadata['dist'] : {}
  const integrity = String(dist['integrity'] ?? '')
    .split(/\s+/)
    .find((hash) => hash.startsWith('sha512-'))
  const { tarball } = dist
  if (typeof tarball !== 'string' || !integrity) {
    throw new Error('the registry lists no sha512 tarball')
  }
  assertSecure(tarball)
  // Mirrors redirect tarballs to a CDN; the digest above was fetched securely and decides.
  const response = await fetch(tarball, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`the tarball download answered HTTP ${response.status}`)
  }
  const archive = new Uint8Array(await response.arrayBuffer())
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== integrity) {
    throw new Error('the tarball does not match the registry sha512')
  }
  const members = extractTarFiles(archive, [PLUGIN_MEMBER, MCP_MEMBER])
  const plugin = members.get(PLUGIN_MEMBER)
  const mcpServer = members.get(MCP_MEMBER)
  if (!plugin || !mcpServer) {
    throw new Error('the package has no OpenCode plugin or MCP server')
  }
  // Stage the whole version directory and rename it into place: a reader sees both files
  // or neither, and two OpenCode processes syncing at once cannot interleave.
  const staged = join(root, `.${version}.${process.pid}.tmp`)
  rmSync(staged, { recursive: true, force: true })
  mkdirSync(staged, { recursive: true })
  try {
    writeFileSync(join(staged, PLUGIN_FILE), plugin)
    writeFileSync(join(staged, MCP_FILE), mcpServer)
    renameSync(staged, join(root, version))
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    const placed = filesFor(root, version)
    if (placed) {
      // Another process placed the same version first.
      return placed
    }
    throw error
  }
  // Older versions stay on disk: another OpenCode process, or an MCP server registered
  // earlier, may still be running from them.
  const files = filesFor(root, version)
  if (!files) {
    throw new Error('the downloaded files could not be stored')
  }
  return files
}

const inFlight = new Map<string, Promise<SyncResult>>()

/** The official files for `version`, downloading them once when they are not on disk. */
export function syncOfficial(version: string, options: SyncOptions = {}): Promise<SyncResult> {
  if (!VERSION.test(version)) {
    return Promise.resolve({ ok: false, reason: `"${version}" is not a claude-mem version` })
  }
  const root = options.root ?? officialRoot()
  const cached = filesFor(root, version)
  if (cached) {
    return Promise.resolve({ ok: true, files: cached })
  }
  const key = `${root}\0${version}`
  const running = inFlight.get(key)
  if (running) {
    return running
  }
  const started = download(root, version, options.registry ?? npmRegistry())
    .then((files): SyncResult => ({ ok: true, files }))
    .catch(
      (error: unknown): SyncResult => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      })
    )
    .finally(() => inFlight.delete(key))
  inFlight.set(key, started)
  return started
}
