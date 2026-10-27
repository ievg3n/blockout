import type { McpTool } from '../mcp/tools.mjs'

export const DEFAULT_OUT: string
export function mcpbManifest(options: { version: string; tools: McpTool[] }): Record<string, unknown> & {
  manifest_version: string
  name: string
  version: string
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[] } }
  tools: { name: string; description: string }[]
}
export function zipStore(entries: { name: string; data: Buffer }[]): Buffer
export function buildMcpb(outFile?: string): Promise<{ outFile: string; manifest: ReturnType<typeof mcpbManifest> }>
