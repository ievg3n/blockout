/**
 * The agent loop: user text → model step → tool calls executed against the
 * live app (the same control actions the MCP bridge drives) → results back
 * to the model → repeat until it answers without tools. Provider-agnostic:
 * a ProviderConversation owns the wire format and the append-only history.
 */

import { randomUUID } from 'crypto'
import type { ControlInvoke, ControlResult } from '../control'
import { AGENT_TOOL_NAMES } from './tools'
import type { AgentEvent, ProviderConversation, ToolCall, ToolOutcome } from './types'

export const MAX_TOOL_ROUNDS = 25
/** Tool JSON handed back to the model is capped so one huge reply can't flood the context. */
const MAX_RESULT_CHARS = 40_000

export interface SessionDeps {
  invoke: ControlInvoke
  emit: (event: AgentEvent) => void
  /** Shrink/convert a screenshot before it goes to the model (main uses nativeImage). */
  prepareImage?: (pngBase64: string) => NonNullable<ToolOutcome['image']>
  allowedTools?: Set<string>
}

const isAbort = (e: unknown, signal: AbortSignal): boolean =>
  signal.aborted || (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message)))

function summarize(result: ControlResult): string {
  if (!result.ok) return result.error ?? 'failed'
  const data = result.data
  if (data === undefined || data === null) return 'ok'
  if (typeof data === 'object' && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>
    for (const key of ['entityId', 'shotId', 'scanId', 'id']) {
      if (typeof rec[key] === 'string') return `${key} ${rec[key] as string}`
    }
    if (Array.isArray(rec.entityIds)) return `${rec.entityIds.length} entities`
  }
  if (Array.isArray(data)) return `${data.length} items`
  const json = JSON.stringify(data)
  return json.length > 100 ? json.slice(0, 97) + '…' : json
}

export class AgentSession {
  private running: AbortController | null = null

  constructor(
    private readonly conversation: ProviderConversation,
    private readonly deps: SessionDeps
  ) {}

  get busy(): boolean {
    return this.running !== null
  }

  stop(): void {
    this.running?.abort()
  }

  async send(text: string): Promise<void> {
    const { emit } = this.deps
    if (this.running) {
      emit({ type: 'error', message: 'The agent is still working — stop it or wait for the reply.' })
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    this.running = controller
    const usage = { input: 0, output: 0 }
    emit({ type: 'start', turnId: randomUUID() })
    this.conversation.addUserText(text)

    try {
      for (let round = 0; ; round++) {
        if (round >= MAX_TOOL_ROUNDS) {
          emit({ type: 'notice', text: `Paused after ${MAX_TOOL_ROUNDS} tool rounds — say “continue” to keep going.` })
          break
        }
        const step = await this.conversation.step({
          signal,
          onText: (t) => emit({ type: 'text-delta', text: t }),
          onThinking: (t) => emit({ type: 'thinking-delta', text: t })
        })
        usage.input += step.usage?.input ?? 0
        usage.output += step.usage?.output ?? 0
        if (step.stop === 'refusal') emit({ type: 'notice', text: 'The model declined this request.' })
        if (step.stop === 'max_tokens') emit({ type: 'notice', text: 'The reply hit the output limit and was cut off.' })
        if (step.toolCalls.length === 0) break

        // Every call the model made gets an answer — even after Stop — so
        // the provider history never holds an unanswered tool call.
        const outcomes: ToolOutcome[] = []
        for (const call of step.toolCalls) {
          outcomes.push(signal.aborted ? this.cancelled(call) : await this.runTool(call))
        }
        this.conversation.addToolResults(outcomes)
        if (signal.aborted) break
      }
      if (signal.aborted) emit({ type: 'notice', text: 'Stopped.' })
    } catch (e) {
      if (isAbort(e, signal)) emit({ type: 'notice', text: 'Stopped.' })
      else emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.running = null
      emit({ type: 'done', usage })
    }
  }

  private cancelled(call: ToolCall): ToolOutcome {
    return { call, ok: false, text: JSON.stringify({ ok: false, error: 'Cancelled by the user.' }) }
  }

  private async runTool(call: ToolCall): Promise<ToolOutcome> {
    const { emit, invoke } = this.deps
    const allowed = this.deps.allowedTools ?? AGENT_TOOL_NAMES
    emit({ type: 'tool-start', callId: call.id, name: call.name, args: call.args })

    let result: ControlResult
    if (!call.args) {
      result = { ok: false, error: 'Arguments were not a valid JSON object — call the tool again.' }
    } else if (!allowed.has(call.name)) {
      result = { ok: false, error: `Unknown tool: ${call.name}` }
    } else {
      try {
        result = await invoke(call.name, call.args)
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }

    const data = result.data as { imageBase64?: unknown } | undefined
    if (result.ok && typeof data?.imageBase64 === 'string') {
      const image = this.deps.prepareImage?.(data.imageBase64) ?? {
        base64: data.imageBase64,
        mediaType: 'image/png' as const
      }
      emit({
        type: 'tool-end',
        callId: call.id,
        ok: true,
        summary: 'screenshot',
        imageDataUrl: `data:${image.mediaType};base64,${image.base64}`
      })
      return { call, ok: true, text: JSON.stringify({ ok: true, data: 'Viewport screenshot attached.' }), image }
    }

    let text = JSON.stringify(result)
    if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + ' …[truncated]'
    emit({ type: 'tool-end', callId: call.id, ok: result.ok, summary: summarize(result) })
    return { call, ok: result.ok, text }
  }
}
