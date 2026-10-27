#!/usr/bin/env node
/**
 * Build the Claude Desktop extension (MCP Bundle, .mcpb): a zip holding a
 * manifest.json and the zero-dependency stdio bridge. Claude Desktop runs it
 * with its built-in Node, so users need nothing installed — double-click the
 * file (or use Connections → Install in Claude Desktop) and approve.
 *
 * Usage: node scripts/build-mcpb.mjs [outFile]   (default mcp/dist/Blockout.mcpb)
 * No dependencies: a stored (uncompressed) zip with zlib's CRC-32.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
export const DEFAULT_OUT = join(ROOT, 'mcp', 'dist', 'Blockout.mcpb')
const SERVER_FILES = ['blockout-mcp.mjs', 'tools.mjs', 'protocol.mjs']
const REPO_URL = 'https://github.com/ievg3n/blockout'

export function mcpbManifest({ version, tools }) {
  return {
    manifest_version: '0.3',
    name: 'blockout',
    display_name: 'Blockout',
    version,
    description: 'Drive the Blockout previs app: stage scenes, choreograph actors and cameras, pose limbs, and grab viewport screenshots.',
    long_description:
      'Connects Claude to a running copy of Blockout on this computer. Claude can place people, vehicles and sets, ' +
      'lay actor and camera marks on the timeline, apply camera moves and choreography, key limb poses, and look at the ' +
      'result through viewport screenshots. Launch Blockout and open a project first; everything Claude does is undoable ' +
      'in the app. The connection is local only (127.0.0.1, token-protected).',
    author: { name: 'Sam Wasserman (Blockout) · fork by ievg3n', url: REPO_URL },
    repository: { type: 'git', url: `${REPO_URL}.git` },
    homepage: REPO_URL,
    documentation: `${REPO_URL}/blob/main/mcp/README.md`,
    support: `${REPO_URL}/issues`,
    license: 'Apache-2.0',
    icon: 'icon.png',
    keywords: ['previs', 'film', 'animation', '3d', 'blocking', 'camera'],
    server: {
      type: 'node',
      entry_point: 'server/blockout-mcp.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/blockout-mcp.mjs'],
        env: {}
      }
    },
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: '>=18.0.0' }
    }
  }
}

// DOS date 1980-01-01 00:00 — fixed so the archive is reproducible.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/** A minimal stored (method 0) zip with UTF-8 names. */
export function zipStore(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by: UNIX, 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // external attrs: regular file 0644
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, end])
}

export async function buildMcpb(outFile = DEFAULT_OUT) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'))
  const { TOOLS } = await import(pathToFileURL(join(ROOT, 'mcp', 'tools.mjs')).href)
  const manifest = mcpbManifest({ version: pkg.version, tools: TOOLS })
  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'icon.png', data: await readFile(join(ROOT, 'mcp', 'icon.png')) },
    { name: 'LICENSE', data: await readFile(join(ROOT, 'LICENSE')) },
    ...(await Promise.all(
      SERVER_FILES.map(async (f) => ({ name: `server/${f}`, data: await readFile(join(ROOT, 'mcp', f)) }))
    ))
  ]
  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, zipStore(entries))
  return { outFile, manifest }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { outFile, manifest } = await buildMcpb(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT)
  console.log(`Built ${outFile} (${manifest.tools.length} tools, v${manifest.version}).`)
}
