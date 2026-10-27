/**
 * Remote MCP endpoint for ChatGPT (and claude.ai custom connectors), which
 * only accept MCP servers reachable over public HTTPS. Off by default and
 * never remembered as on: the user starts it from Connections, an ngrok
 * tunnel publishes it, and stopping (or quitting) takes it down.
 *
 * Transport: MCP Streamable HTTP, answered with plain JSON (no SSE). The
 * only route is POST /mcp/<secret>; the secret is persistent so a fixed
 * ngrok domain keeps one stable connector URL, and "new link" rotates it.
 * Tools are the sandboxed catalog — nothing that reads local files.
 */

import crypto from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'
import { createMcpHandler, type JsonRpcMessage } from '../../mcp/protocol.mjs'
import { sandboxedTools } from '../../mcp/tools.mjs'
import { version as APP_VERSION } from '../../package.json'
import type { ControlInvoke } from './control'

const MAX_BODY = 1024 * 1024

export interface RemoteMcpServer {
  port: number
  close(): Promise<void>
}

export interface RemoteMcpOptions {
  /** Read on every request, so rotating takes effect immediately. */
  getSecret: () => string
  invoke: ControlInvoke
  onActivity?: (tool: string, ok: boolean) => void
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export async function startRemoteMcpServer(opts: RemoteMcpOptions): Promise<RemoteMcpServer> {
  const handle = createMcpHandler({
    tools: sandboxedTools(),
    serverInfo: { name: 'blockout', version: APP_VERSION },
    callControl: async (action, params) => {
      const response = await opts.invoke(action, params)
      opts.onActivity?.(action, response.ok)
      return { response }
    }
  })

  const server = http.createServer((req, res) => {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}): void => {
      if (body === undefined) {
        res.writeHead(status, headers).end()
        return
      }
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
    }

    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!path.startsWith('/mcp/') || !safeEqual(path.slice('/mcp/'.length), opts.getSecret())) {
      send(404, { error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      // No server-initiated SSE stream and no session teardown to do.
      send(405, { error: 'method not allowed' }, { Allow: 'POST' })
      return
    }

    let body = ''
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      body += chunk
      if (body.length > MAX_BODY) {
        aborted = true
        send(413, { error: 'request body too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (aborted) return
      let parsed: JsonRpcMessage | JsonRpcMessage[]
      try {
        parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[]
      } catch {
        send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      const batch = Array.isArray(parsed)
      const messages: JsonRpcMessage[] = Array.isArray(parsed) ? parsed : [parsed]
      void Promise.all(messages.map((m) => handle(m))).then((replies) => {
        const out = replies.filter((r): r is Record<string, unknown> => r !== null)
        // Only notifications/responses: accepted, nothing to say.
        if (out.length === 0) {
          send(202)
          return
        }
        const headers: Record<string, string> = {}
        if (messages.some((m) => m.method === 'initialize')) headers['Mcp-Session-Id'] = crypto.randomUUID()
        send(200, batch ? out : out[0], headers)
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export function newRemoteSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}
