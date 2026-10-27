export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

export const TOOLS: McpTool[]
export const FILE_TOOLS: string[]
export function sandboxedTools(): McpTool[]
