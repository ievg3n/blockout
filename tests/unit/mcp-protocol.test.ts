import { describe, expect, it, vi } from 'vitest'
import { FILE_TOOLS, TOOLS, sandboxedTools } from '../../mcp/tools.mjs'
import { createMcpHandler, negotiateProtocolVersion, toolResult } from '../../mcp/protocol.mjs'

describe('MCP tool catalog', () => {
  it('has unique names and object schemas', () => {
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of TOOLS) {
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(t.description.length, t.name).toBeGreaterThan(10)
    }
  })

  it('withholds the filesystem tools from the sandboxed set', () => {
    const sandboxed = sandboxedTools().map((t) => t.name)
    for (const name of FILE_TOOLS) {
      expect(TOOLS.some((t) => t.name === name)).toBe(true)
      expect(sandboxed).not.toContain(name)
    }
    expect(sandboxed.length).toBe(TOOLS.length - FILE_TOOLS.length)
  })
})

describe('MCP JSON-RPC handler', () => {
  const tools = sandboxedTools()

  it('negotiates the protocol version', async () => {
    expect(negotiateProtocolVersion('2024-11-05')).toBe('2024-11-05')
    expect(negotiateProtocolVersion('1999-01-01')).toBe('2025-06-18')
    const handle = createMcpHandler({ tools, callControl: vi.fn() })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    expect(reply).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } })
  })

  it('lists exactly the tools it was given and ignores notifications', async () => {
    const handle = createMcpHandler({ tools, callControl: vi.fn() })
    const reply = await handle({ jsonrpc: '2.0', id: 'a', method: 'tools/list' })
    expect((reply?.result as { tools: unknown[] }).tools).toEqual(tools)
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).toMatchObject({
      error: { code: -32601 }
    })
  })

  it('forwards tool calls and maps text, image, and error results', async () => {
    const callControl = vi.fn(async (action: string) => {
      if (action === 'screenshot') return { response: { ok: true, data: { imageBase64: 'iVBOR' } } }
      if (action === 'delete_entity') return { response: { ok: false, error: 'no such entity' } }
      if (action === 'play') return { error: "Blockout isn't running — launch the app first." }
      return { response: { ok: true, data: { entityId: 'e1' } } }
    })
    const handle = createMcpHandler({ tools, callControl })
    const call = (name: string, args: Record<string, unknown> = {}) =>
      handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } })

    const added = await call('add_entity', { assetId: 'person.man', x: 0, z: 0 })
    expect(callControl).toHaveBeenCalledWith('add_entity', { assetId: 'person.man', x: 0, z: 0 })
    expect(added?.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { entityId: 'e1' } }) }],
      isError: false
    })
    expect(await call('screenshot')).toMatchObject({
      result: { content: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }] }
    })
    expect(await call('delete_entity', { entityId: 'x' })).toMatchObject({ result: { isError: true } })
    expect(await call('play')).toMatchObject({ result: { isError: true } })
  })

  it('rejects tools outside its catalog without calling the app', async () => {
    const callControl = vi.fn()
    const handle = createMcpHandler({ tools, callControl })
    const reply = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'import_scan', arguments: {} } })
    expect(reply?.result).toMatchObject({ isError: true })
    expect(callControl).not.toHaveBeenCalled()
  })

  it('maps a bare ok reply to plain text', () => {
    expect(toolResult({ ok: true }).content[0]).toEqual({ type: 'text', text: '{"ok":true}' })
  })
})
