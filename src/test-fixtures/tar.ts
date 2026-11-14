import { gzipSync } from 'node:zlib'

const BLOCK = 512

function field(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(new TextEncoder().encode(value).subarray(0, length), offset)
}

/**
 * A gzipped ustar archive, as `npm pack` writes one. `type` '5' adds a directory entry;
 * a `prefix` exercises the split name of paths longer than 100 bytes.
 */
export function makeTarGz(
  entries: readonly { name: string; body?: string; type?: string; prefix?: string }[]
): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    const body = new TextEncoder().encode(entry.body ?? '')
    const header = new Uint8Array(BLOCK)
    field(header, 0, 100, entry.name)
    field(header, 100, 8, '0000644\0')
    field(header, 124, 12, `${body.length.toString(8).padStart(11, '0')}\0`)
    field(header, 136, 12, '00000000000\0')
    field(header, 148, 8, '        ')
    field(header, 156, 1, entry.type ?? '0')
    field(header, 257, 8, 'ustar\u000000')
    field(header, 345, 155, entry.prefix ?? '')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    field(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK)
    padded.set(body)
    blocks.push(header, padded)
  }
  blocks.push(new Uint8Array(BLOCK * 2))
  const tar = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0))
  let offset = 0
  for (const block of blocks) {
    tar.set(block, offset)
    offset += block.length
  }
  return gzipSync(tar)
}

/** The two files this package takes from a `claude-mem` release, as a release tarball. */
export function officialTarball(plugin: string, mcpServer: string): Uint8Array {
  return makeTarGz([
    { name: 'package/', type: '5' },
    { name: 'package/package.json', body: '{"name":"claude-mem"}' },
    { name: 'package/dist/opencode-plugin/index.js', body: plugin },
    { name: 'package/plugin/scripts/mcp-server.cjs', body: mcpServer },
  ])
}
