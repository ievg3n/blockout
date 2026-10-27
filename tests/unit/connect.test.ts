import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { crc32 } from 'zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMcpb, mcpbManifest, zipStore } from '../../scripts/build-mcpb.mjs'
import { TOOLS } from '../../mcp/tools.mjs'
import { newRemoteSecret, startRemoteMcpServer, type RemoteMcpServer } from '../../src/main/remote-mcp'
import { classifyNgrokError, findNgrok, ngrokArgs } from '../../src/main/tunnel'

/** Read a stored zip back through its central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen)
    expect(buf.readUInt32LE(local)).toBe(0x04034b50)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    expect(crc32(data) >>> 0).toBe(crc)
    out.set(name, data)
    p += 46 + nameLen
  }
  return out
}

describe('Claude Desktop extension (.mcpb)', () => {
  it('writes a valid stored zip', () => {
    const files = unzip(zipStore([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/ü.json', data: Buffer.from('{}') }
    ]))
    expect([...files.keys()]).toEqual(['a.txt', 'dir/ü.json'])
    expect(files.get('a.txt')!.toString()).toBe('hello')
  })

  it('declares a node server and the full tool catalog', () => {
    const m = mcpbManifest({ version: '9.9.9', tools: TOOLS })
    expect(m).toMatchObject({
      manifest_version: '0.3',
      name: 'blockout',
      version: '9.9.9',
      server: {
        type: 'node',
        entry_point: 'server/blockout-mcp.mjs',
        mcp_config: { command: 'node', args: ['${__dirname}/server/blockout-mcp.mjs'] }
      }
    })
    expect(m.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
  })

  it('bundles the bridge with its modules, icon, and license', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'blockout-mcpb-')), 'Blockout.mcpb')
    await buildMcpb(out)
    const files = unzip(readFileSync(out))
    expect([...files.keys()].sort()).toEqual(
      ['LICENSE', 'icon.png', 'manifest.json', 'server/blockout-mcp.mjs', 'server/protocol.mjs', 'server/tools.mjs'].sort()
    )
    const manifest = JSON.parse(files.get('manifest.json')!.toString())
    expect(manifest.version).toBe(JSON.parse(readFileSync('package.json', 'utf-8')).version)
    expect(files.get('server/blockout-mcp.mjs')!.toString()).toContain("from './tools.mjs'")
  })
})

describe('remote MCP endpoint', () => {
  let server: RemoteMcpServer | null = null
  afterEach(async () => {
    await server?.close()
    server = null
  })

  async function start() {
    let secret = newRemoteSecret()
    const invoke = vi.fn(async (action: string) =>
      action === 'add_entity' ? { ok: true, data: { entityId: 'e1' } } : { ok: false, error: 'nope' }
    )
    const activity: [string, boolean][] = []
    server = await startRemoteMcpServer({ getSecret: () => secret, invoke, onActivity: (t, ok) => activity.push([t, ok]) })
    const base = `http://127.0.0.1:${server.port}`
    const post = (body: unknown, path = `/mcp/${secret}`) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      })
    return { base, post, invoke, activity, rotate: () => (secret = newRemoteSecret()), secret: () => secret }
  }

  it('answers only on the secret path and only to POST', async () => {
    const { base, post, secret } = await start()
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp/wrong')).status).toBe(404)
    expect((await fetch(`${base}/`)).status).toBe(404)
    const get = await fetch(`${base}/mcp/${secret()}`)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect((await post('{nope')).status).toBe(400)
    expect((await post('x'.repeat(1024 * 1024 + 10))).status).toBe(413)
  })

  it('speaks MCP over JSON: initialize, tools/list without file tools, tools/call', async () => {
    const { post, invoke, activity } = await start()
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(init.status).toBe(200)
    expect(init.headers.get('mcp-session-id')).toBeTruthy()
    expect(await init.json()).toMatchObject({ result: { protocolVersion: '2025-06-18' } })

    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)

    const list = (await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: { name: string }[] } }
    const names = list.result.tools.map((t) => t.name)
    expect(names).toContain('add_entity')
    expect(names).not.toContain('import_scan')
    expect(names).not.toContain('set_reference')

    const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_entity', arguments: { assetId: 'person.man', x: 0, z: 0 } } })
    expect(await call.json()).toMatchObject({ result: { isError: false } })
    expect(invoke).toHaveBeenCalledWith('add_entity', { assetId: 'person.man', x: 0, z: 0 })
    const blocked = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'import_scan', arguments: { sourcePath: '/x' } } })
    expect(await blocked.json()).toMatchObject({ result: { isError: true } })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(activity).toEqual([['add_entity', true]])

    const batch = await post([{ jsonrpc: '2.0', id: 5, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])
    expect(await batch.json()).toEqual([{ jsonrpc: '2.0', id: 5, result: {} }])
  })

  it('stops accepting the old link after rotation', async () => {
    const { post, rotate } = await start()
    const old = await post({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(old.status).toBe(200)
    const before = old.url.split('/mcp/')[1]!
    rotate()
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, `/mcp/${before}`)).status).toBe(404)
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200)
  })
})

describe('ngrok tunnel helpers', () => {
  it('builds the agent command line', () => {
    expect(ngrokArgs(4321)).toEqual(['http', '127.0.0.1:4321', '--log', 'stdout', '--log-format', 'json'])
    expect(ngrokArgs(4321, 'https://me.ngrok-free.app/')).toContain('https://me.ngrok-free.app')
  })

  it('classifies the failures the UI explains', () => {
    expect(classifyNgrokError('ERROR: authentication failed: ERR_NGROK_4018')?.code).toBe('auth')
    expect(classifyNgrokError('unknown flag: --url')?.code).toBe('outdated')
    expect(classifyNgrokError('failed to start tunnel: ERR_NGROK_320 domain not reserved')?.code).toBe('domain')
    expect(classifyNgrokError('ERR_NGROK_8012 upstream')?.code).toBe('other')
    expect(classifyNgrokError('client session established')).toBeNull()
  })

  it('finds ngrok on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blockout-ngrok-'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'ngrok'), '')
    expect(findNgrok({ PATH: join(dir, 'bin') }, 'darwin')).toBe(join(dir, 'bin', 'ngrok'))
  })
})
