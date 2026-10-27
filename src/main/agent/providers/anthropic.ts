/**
 * Claude via the Anthropic SDK: streamed manual tool loop, adaptive
 * thinking (summaries shown in the panel), server-side refusal fallback,
 * and top-level prompt caching over the frozen tools + system prefix.
 * History is append-only and keeps every assistant block (thinking
 * included) exactly as returned.
 */

import Anthropic from '@anthropic-ai/sdk'
import { AGENT_SYSTEM_PROMPT } from '../system-prompt'
import { anthropicTools } from '../tools'
import type { ProviderConversation, StepCallbacks, StepResult, ToolOutcome } from '../types'

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5'
export const ANTHROPIC_SUGGESTED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

const MAX_TOKENS = 64_000
/** Unparseable streamed tool input re-issues the turn at most this many times. */
const JSON_RETRIES = 2

/** Request knobs per model family; older or unknown models get a plain request. */
export function anthropicModelOptions(model: string): {
  adaptive: boolean
  fallback: boolean
} {
  const adaptive = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-(opus|sonnet)-4-[678]/.test(model)
  // Haiku has no server-side fallback; Opus 5.x, Fable 5.x and Sonnet 5.5 do.
  const fallback = /^claude-(fable-5|opus-5|sonnet-5-5)/.test(model)
  return { adaptive, fallback }
}

export class AnthropicConversation implements ProviderConversation {
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = []
  private readonly tools = anthropicTools()

  constructor(
    private readonly client: Anthropic,
    private readonly model: string
  ) {}

  addUserText(text: string): void {
    this.messages.push({ role: 'user', content: text })
  }

  async step(cb: StepCallbacks): Promise<StepResult> {
    const opts = anthropicModelOptions(this.model)
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          ...(opts.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          ...(opts.adaptive
            ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const }, output_config: { effort: 'medium' as const } }
            : {}),
          cache_control: { type: 'ephemeral' },
          system: AGENT_SYSTEM_PROMPT,
          tools: this.tools,
          messages: this.messages
        },
        { signal: cb.signal }
      )
      stream.on('text', (delta) => cb.onText(delta))
      stream.on('thinking', (delta) => cb.onThinking?.(delta))

      let message: Anthropic.Beta.BetaMessage
      try {
        message = await stream.finalMessage()
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API errors,
        // aborts, and repeated failures surface to the session.
        if (err instanceof Anthropic.APIError || cb.signal.aborted || attempt >= JSON_RETRIES) throw err
        continue
      }

      const usage = {
        input:
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
        output: message.usage.output_tokens
      }
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')

      // A refusal can cut a tool_use off mid-input, and a tool input cut at
      // max_tokens may parse as a valid partial object: never run those, and
      // keep them out of history so no tool call is left unanswered.
      if (message.stop_reason === 'refusal') return { toolCalls: [], stop: 'refusal', usage }
      if (message.stop_reason === 'max_tokens' && toolUses.length > 0) {
        return { toolCalls: [], stop: 'max_tokens', usage }
      }

      this.messages.push({ role: 'assistant', content: message.content })
      if (message.stop_reason === 'max_tokens') return { toolCalls: [], stop: 'max_tokens', usage }
      return {
        toolCalls: toolUses.map((b) => ({
          id: b.id,
          name: b.name,
          args: b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : null
        })),
        stop: toolUses.length > 0 ? 'tools' : 'end',
        usage
      }
    }
  }

  addToolResults(results: ToolOutcome[]): void {
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.call.id,
        is_error: !r.ok,
        content: r.image
          ? [
              { type: 'text' as const, text: r.text },
              { type: 'image' as const, source: { type: 'base64' as const, media_type: r.image.mediaType, data: r.image.base64 } }
            ]
          : r.text
      }))
    })
  }
}

export async function listAnthropicModels(client: Anthropic): Promise<string[]> {
  const ids: string[] = []
  for await (const m of client.models.list()) ids.push(m.id)
  return ids
}
