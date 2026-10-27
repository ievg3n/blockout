import type { McpTool } from './tools.mjs'

export interface ControlResponse {
  ok: boolean
  data?: unknown
  error?: string
}

export type CallControl = (
  action: string,
  params: Record<string, unknown>
) => Promise<{ response?: ControlResponse; error?: string }>

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export const SUPPORTED_PROTOCOL_VERSIONS: string[]
export function negotiateProtocolVersion(requested: unknown): string
export function toolResult(response: ControlResponse | undefined): {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
export function createMcpHandler(options: {
  tools: McpTool[]
  callControl: CallControl
  serverInfo?: { name: string; version: string }
}): (msg: JsonRpcMessage) => Promise<Record<string, unknown> | null>
