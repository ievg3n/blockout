// Blockout MCP JSON-RPC handling — transport-agnostic. The stdio bridge feeds
// it newline-delimited messages; the remote endpoint (src/main/remote-mcp.ts)
// feeds it HTTP POST bodies. Plain ESM with no imports so it ships unbundled.

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** Echo the client's protocol version when we speak it, else offer our newest. */
export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]
}

/** Map a control-server reply ({ ok, data?, error? }) to an MCP tools/call result. */
export function toolResult(response) {
  // Image special-case: an ok screenshot returns base64 PNG data.
  if (response && response.ok && response.data && typeof response.data.imageBase64 === 'string') {
    return { content: [{ type: 'image', data: response.data.imageBase64, mimeType: 'image/png' }] }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    isError: response && response.ok === false
  }
}

const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * Build a handler for one JSON-RPC message. `callControl(action, params)`
 * resolves to `{ response }` (the control reply) or `{ error }` (a transport
 * failure, shown to the model as an error result). Resolves to the JSON-RPC
 * reply, or null for notifications.
 */
export function createMcpHandler({ tools, callControl, serverInfo = { name: 'blockout', version: '1.0.0' } }) {
  const toolNames = new Set(tools.map((t) => t.name))
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result })

  return async function handle(msg) {
    const { id, method, params } = msg ?? {}
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo
        })
      case 'tools/list':
        return ok(id, { tools })
      case 'tools/call': {
        const name = params?.name
        if (!toolNames.has(name)) return ok(id, errorResult(`Unknown tool: ${name}`))
        const { response, error } = await callControl(name, params?.arguments ?? {})
        return ok(id, error ? errorResult(error) : toolResult(response))
      }
      case 'ping':
        return ok(id, {})
      default:
        // Notifications (no id) are ignored; requests get method-not-found.
        if (id === undefined || id === null) return null
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    }
  }
}
