/**
 * The agent's tool surface: the shared MCP catalog (mcp/tools.mjs) minus
 * the filesystem tools, converted to each provider's wire format. Order is
 * the catalog's, so the serialized tool list is byte-stable for caching.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { sandboxedTools, type McpTool } from '../../../mcp/tools.mjs'

export const AGENT_TOOLS: McpTool[] = sandboxedTools()
export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name))

export function anthropicTools(tools: McpTool[] = AGENT_TOOLS): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    // Stream tool inputs as generated; the renderer handler validates every
    // param it reads, and unparseable JSON re-issues the turn.
    eager_input_streaming: true
  }))
}

export function responsesTools(tools: McpTool[] = AGENT_TOOLS): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    strict: false
  }))
}

export function chatTools(tools: McpTool[] = AGENT_TOOLS): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> }
  }))
}

/** Parse a provider's JSON-string arguments; null when malformed or not an object. */
export function parseArgs(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
