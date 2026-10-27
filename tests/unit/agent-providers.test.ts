import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { AGENT_TOOLS, anthropicTools, chatTools, parseArgs, responsesTools } from '../../src/main/agent/tools'
import { AnthropicConversation, anthropicModelOptions } from '../../src/main/agent/providers/anthropic'
import { ChatConversation, ResponsesConversation } from '../../src/main/agent/providers/openai'
import { FILE_TOOLS } from '../../mcp/tools.mjs'
import type { StepCallbacks, ToolOutcome } from '../../src/main/agent/types'

const cb = (): StepCallbacks & { text: string[]; thinking: string[] } => {
  const text: string[] = []
  const thinking: string[] = []
  return {
    signal: new AbortController().signal,
    onText: (t) => text.push(t),
    onThinking: (t) => thinking.push(t),
    text,
    thinking
  }
}

async function* iterate<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

const shot: ToolOutcome['image'] = { base64: 'JPEG', mediaType: 'image/jpeg' }

describe('agent tool surface', () => {
  it('converts the sandboxed catalog for every wire format', () => {
    const names = AGENT_TOOLS.map((t) => t.name)
    for (const f of FILE_TOOLS) expect(names).not.toContain(f)
    expect(anthropicTools().map((t) => t.name)).toEqual(names)
    expect(anthropicTools()[0]).toMatchObject({ eager_input_streaming: true, input_schema: { type: 'object' } })
    expect(responsesTools()[0]).toMatchObject({ type: 'function', name: names[0], parameters: { type: 'object' } })
    expect(chatTools()[0]).toMatchObject({ type: 'function', function: { name: names[0] } })
  })

  it('parses tool arguments defensively', () => {
    expect(parseArgs('{"x":1}')).toEqual({ x: 1 })
    expect(parseArgs('')).toEqual({})
    expect(parseArgs('[1]')).toBeNull()
    expect(parseArgs('{"x":')).toBeNull()
  })

  it('only sends thinking/fallback options to models that accept them', () => {
    expect(anthropicModelOptions('claude-opus-5-5')).toEqual({ adaptive: true, fallback: true })
    expect(anthropicModelOptions('claude-sonnet-5-5')).toEqual({ adaptive: true, fallback: true })
    expect(anthropicModelOptions('claude-haiku-5-5')).toEqual({ adaptive: true, fallback: false })
    expect(anthropicModelOptions('claude-haiku-4-5')).toEqual({ adaptive: false, fallback: false })
  })
})

describe('AnthropicConversation', () => {
  function client(messages: Partial<Anthropic.Beta.BetaMessage>[]) {
    const stream = vi.fn((params: Anthropic.Beta.MessageCreateParams) => {
      const message = messages.shift()!
      return {
        on: vi.fn(),
        finalMessage: async () => ({
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
          ...message
        }),
        params
      }
    })
    return { client: { beta: { messages: { stream } } } as unknown as Anthropic, stream }
  }

  it('keeps the full assistant turn and returns tool_use as tool calls', async () => {
    const content = [
      { type: 'thinking', thinking: 'plan', signature: 's' },
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'tu_1', name: 'get_state', input: {} }
    ]
    const { client: c, stream } = client([{ stop_reason: 'tool_use', content: content as never }])
    const conv = new AnthropicConversation(c, 'claude-opus-5-5')
    conv.addUserText('hi')
    const step = await conv.step(cb())
    expect(step).toEqual({
      toolCalls: [{ id: 'tu_1', name: 'get_state', args: {} }],
      stop: 'tools',
      usage: { input: 100, output: 5 }
    })
    const params = stream.mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' }
    })
    conv.addToolResults([{ call: step.toolCalls[0]!, ok: true, text: '{"ok":true}', image: shot }])
    const messages = params.messages as Anthropic.Beta.BetaMessageParam[]
    expect(messages[1]).toEqual({ role: 'assistant', content })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          is_error: false,
          content: [
            { type: 'text', text: '{"ok":true}' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'JPEG' } }
          ]
        }
      ]
    })
  })

  it('never keeps a refused or truncated tool turn in history', async () => {
    const toolUse = { type: 'tool_use', id: 't', name: 'play', input: {} }
    const { client: c, stream } = client([
      { stop_reason: 'refusal', content: [toolUse] as never },
      { stop_reason: 'max_tokens', content: [toolUse] as never }
    ])
    const conv = new AnthropicConversation(c, 'claude-opus-5-5')
    conv.addUserText('x')
    expect((await conv.step(cb())).stop).toBe('refusal')
    expect((await conv.step(cb())).stop).toBe('max_tokens')
    const messages = (stream.mock.calls[1]![0] as unknown as { messages: unknown[] }).messages
    expect(messages).toEqual([{ role: 'user', content: 'x' }])
  })
})

describe('ResponsesConversation', () => {
  it('streams text, re-sends output without ids, and returns images inside function_call_output', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'screenshot', arguments: '{}', status: 'completed' }
    ]
    const create = vi.fn(async (params: Record<string, unknown>) => {
      void params
      return iterate([
        { type: 'response.reasoning_summary_text.delta', delta: 'think' },
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 7, output_tokens: 3 } } }
      ])
    })
    const client = { responses: { create } } as unknown as OpenAI
    const conv = new ResponsesConversation(async () => client, 'gpt-x')
    conv.addUserText('hi')
    const c = cb()
    const step = await conv.step(c)
    expect(c.text).toEqual(['ok'])
    expect(c.thinking).toEqual(['think'])
    expect(step).toEqual({
      toolCalls: [{ id: 'call_1', name: 'screenshot', args: {} }],
      stop: 'tools',
      usage: { input: 7, output: 3 }
    })
    expect(create.mock.calls[0]![0]).toMatchObject({ stream: true, store: false, include: ['reasoning.encrypted_content'] })
    conv.addToolResults([{ call: step.toolCalls[0]!, ok: true, text: 'shot', image: shot }])
    const input = create.mock.calls[0]![0].input as Record<string, unknown>[]
    expect(input[1]).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' })
    expect(input[2]).not.toHaveProperty('id')
    expect(input[3]).toMatchObject({ type: 'function_call', call_id: 'call_1' })
    expect(input[3]).not.toHaveProperty('id')
    expect(input[4]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'shot' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,JPEG', detail: 'auto' }
      ]
    })
  })

  it('surfaces in-band failures and treats a stream without completion as an error', async () => {
    const failing = {
      responses: {
        create: async () =>
          iterate([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }])
      }
    } as unknown as OpenAI
    const conv = new ResponsesConversation(async () => failing, 'm')
    conv.addUserText('x')
    await expect(conv.step(cb())).rejects.toMatchObject({ code: 'subscription_sharing_usage_limit_exceeded' })
    const cut = { responses: { create: async () => iterate([]) } } as unknown as OpenAI
    await expect(new ResponsesConversation(async () => cut, 'm').step(cb())).rejects.toThrow(/ended early/)
  })
})

describe('ChatConversation', () => {
  it('assembles streamed tool calls, keeps Gemini thought signatures, and sends screenshots as a user message', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { content: 'Look' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'screen', arguments: '' }, extra_content: { google: { thought_signature: 'SIG' } } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'shot', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } }
    ]
    const create = vi.fn(async (params: Record<string, unknown>) => {
      void params
      return iterate(chunks)
    })
    const conv = new ChatConversation({ chat: { completions: { create } } } as unknown as OpenAI, 'gemini-x')
    conv.addUserText('hi')
    const step = await conv.step(cb())
    expect(step).toEqual({
      toolCalls: [{ id: 'c1', name: 'screenshot', args: {} }],
      stop: 'tools',
      usage: { input: 11, output: 4 }
    })
    conv.addToolResults([{ call: step.toolCalls[0]!, ok: true, text: 'attached', image: shot }])
    const messages = create.mock.calls[0]![0].messages as Record<string, unknown>[]
    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'Look',
      tool_calls: [{ id: 'c1', function: { name: 'screenshot' }, extra_content: { google: { thought_signature: 'SIG' } } }]
    })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'attached' })
    expect(messages[4]).toMatchObject({
      role: 'user',
      content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,JPEG' } }]
    })
  })
})
