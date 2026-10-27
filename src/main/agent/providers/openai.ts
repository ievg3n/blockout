/**
 * OpenAI-family providers through the official `openai` SDK:
 *
 * - ResponsesConversation — the Responses API, for OpenAI API keys and for
 *   Sign in with ChatGPT plan tokens (which require stream: true and
 *   store: false, so the full input is re-sent each step and reasoning is
 *   carried as encrypted content).
 * - ChatConversation — Chat Completions against OpenAI-compatible endpoints
 *   (Gemini, MiniMax, OpenRouter).
 */

import OpenAI from 'openai'
import { AGENT_SYSTEM_PROMPT } from '../system-prompt'
import { chatTools, parseArgs, responsesTools } from '../tools'
import type { ProviderConversation, StepCallbacks, StepResult, ToolCall, ToolOutcome } from '../types'

export type CompatProviderId = 'gemini' | 'minimax' | 'openrouter'

export const COMPAT_BASE_URLS: Record<CompatProviderId, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  minimax: 'https://api.minimax.io/v1',
  openrouter: 'https://openrouter.ai/api/v1'
}

/** OpenRouter attribution headers (shown on openrouter.ai activity). */
export const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://github.com/ievg3n/blockout',
  'X-Title': 'Blockout'
}

const dataUrl = (image: NonNullable<ToolOutcome['image']>): string => `data:${image.mediaType};base64,${image.base64}`

/** Errors a Responses stream reports in-band (plan usage limits arrive this way). */
export class ResponseStreamError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'ResponseStreamError'
  }
}

/* ----------------------------- Responses API ---------------------------- */

type InputItem = OpenAI.Responses.ResponseInputItem

/** Output items re-sent as input. Ids are dropped from messages and calls
 *  (nothing is stored server-side); reasoning keeps its encrypted content. */
function outputAsInput(item: OpenAI.Responses.ResponseOutputItem): InputItem | null {
  switch (item.type) {
    case 'message':
    case 'function_call': {
      const copy: Partial<typeof item> = { ...item }
      delete copy.id
      return copy as unknown as InputItem
    }
    case 'reasoning':
      return item as InputItem
    default:
      return null
  }
}

export class ResponsesConversation implements ProviderConversation {
  private readonly input: InputItem[] = []
  private readonly tools = responsesTools()

  constructor(
    /** Resolved per step so short-lived sign-in tokens can refresh between steps. */
    private readonly getClient: () => Promise<OpenAI>,
    private readonly model: string
  ) {}

  addUserText(text: string): void {
    this.input.push({ role: 'user', content: text })
  }

  async step(cb: StepCallbacks): Promise<StepResult> {
    const client = await this.getClient()
    const stream = await client.responses.create(
      {
        model: this.model,
        instructions: AGENT_SYSTEM_PROMPT,
        input: this.input,
        tools: this.tools,
        stream: true,
        store: false,
        include: ['reasoning.encrypted_content']
      },
      { signal: cb.signal }
    )

    let final: OpenAI.Responses.Response | undefined
    for await (const ev of stream) {
      switch (ev.type) {
        case 'response.output_text.delta':
          cb.onText(ev.delta)
          break
        case 'response.reasoning_summary_text.delta':
          cb.onThinking?.(ev.delta)
          break
        case 'response.completed':
        case 'response.incomplete':
          final = ev.response
          break
        case 'response.failed':
          throw new ResponseStreamError(
            ev.response.error?.message ?? 'The model request failed.',
            ev.response.error?.code ?? undefined
          )
        case 'error':
          throw new ResponseStreamError(ev.message, ev.code ?? undefined)
      }
    }
    // Only response.completed (or an explicit incomplete) counts as success.
    if (!final) throw new ResponseStreamError('The response stream ended early — try again.')

    const usage = { input: final.usage?.input_tokens ?? 0, output: final.usage?.output_tokens ?? 0 }
    const calls: ToolCall[] = final.output
      .filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call')
      .map((o) => ({ id: o.call_id, name: o.name, args: parseArgs(o.arguments) }))
    const refused = final.output.some(
      (o) => o.type === 'message' && o.content.some((c) => c.type === 'refusal')
    )
    const truncated = final.status === 'incomplete' && final.incomplete_details?.reason === 'max_output_tokens'

    if (truncated && calls.length > 0) return { toolCalls: [], stop: 'max_tokens', usage }
    for (const item of final.output) {
      const asInput = outputAsInput(item)
      if (asInput) this.input.push(asInput)
    }
    if (refused && calls.length === 0) return { toolCalls: [], stop: 'refusal', usage }
    if (truncated) return { toolCalls: [], stop: 'max_tokens', usage }
    return { toolCalls: calls, stop: calls.length > 0 ? 'tools' : 'end', usage }
  }

  addToolResults(results: ToolOutcome[]): void {
    for (const r of results) {
      this.input.push({
        type: 'function_call_output',
        call_id: r.call.id,
        output: r.image
          ? [
              { type: 'input_text', text: r.text },
              { type: 'input_image', image_url: dataUrl(r.image), detail: 'auto' }
            ]
          : r.text
      })
    }
  }
}

/* --------------------------- Chat Completions --------------------------- */

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam
type AssembledCall = OpenAI.Chat.ChatCompletionMessageFunctionToolCall & { extra_content?: unknown }

export class ChatConversation implements ProviderConversation {
  private readonly messages: ChatMessage[] = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }]
  private readonly tools = chatTools()

  constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  addUserText(text: string): void {
    this.messages.push({ role: 'user', content: text })
  }

  async step(cb: StepCallbacks): Promise<StepResult> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.messages,
        tools: this.tools,
        stream: true,
        stream_options: { include_usage: true }
      },
      { signal: cb.signal }
    )

    let text = ''
    let finish: string | null = null
    let usage = { input: 0, output: 0 }
    const calls: AssembledCall[] = []
    for await (const chunk of stream) {
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens }
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finish = choice.finish_reason
      const delta = choice.delta as typeof choice.delta & { reasoning?: string; reasoning_content?: string }
      const thinking = delta.reasoning ?? delta.reasoning_content
      if (thinking) cb.onThinking?.(thinking)
      if (delta.content) {
        text += delta.content
        cb.onText(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' }
        })
        if (tc.id) slot.id = tc.id
        // Names normally arrive once; tolerate endpoints that split or repeat them.
        if (tc.function?.name && tc.function.name !== slot.function.name) slot.function.name += tc.function.name
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
        // Gemini returns thought signatures here and requires them back.
        const extra = (tc as { extra_content?: unknown }).extra_content
        if (extra !== undefined) slot.extra_content = extra
      }
    }

    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }))
    if (finish === 'length' && toolCalls.length > 0) return { toolCalls: [], stop: 'max_tokens', usage }
    this.messages.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    })
    if (finish === 'length') return { toolCalls: [], stop: 'max_tokens', usage }
    if (finish === 'content_filter' && toolCalls.length === 0) return { toolCalls: [], stop: 'refusal', usage }
    return {
      toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
      stop: toolCalls.length > 0 ? 'tools' : 'end',
      usage
    }
  }

  addToolResults(results: ToolOutcome[]): void {
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.call.id, content: r.text })
    }
    // Tool messages are text-only on most compatible endpoints, so
    // screenshots follow as one user message.
    const images = results.filter((r) => r.image)
    if (images.length > 0) {
      this.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Viewport screenshot${images.length > 1 ? 's' : ''} from the tool call above.` },
          ...images.map((r) => ({ type: 'image_url' as const, image_url: { url: dataUrl(r.image!) } }))
        ]
      })
    }
  }
}

/* -------------------------------- models -------------------------------- */

const NON_CHAT = /(embed|tts|whisper|transcribe|audio|realtime|moderation|dall-e|image|davinci|babbage|search|instruct)/i

/** Model ids the provider reports, filtered to chat models that can call tools where known. */
export async function listOpenAIModels(client: OpenAI, provider: 'openai' | 'chatgpt' | CompatProviderId): Promise<string[]> {
  const ids: string[] = []
  for await (const m of client.models.list()) {
    const meta = m as typeof m & { visibility?: string; slug?: string; supported_parameters?: string[] }
    if (provider === 'chatgpt') {
      if (meta.visibility === undefined || meta.visibility === 'list') ids.push(meta.slug ?? m.id)
      continue
    }
    if (provider === 'openrouter' && meta.supported_parameters && !meta.supported_parameters.includes('tools')) continue
    const id = provider === 'gemini' ? m.id.replace(/^models\//, '') : m.id
    if (provider !== 'openrouter' && NON_CHAT.test(id)) continue
    ids.push(id)
  }
  return ids.sort()
}
