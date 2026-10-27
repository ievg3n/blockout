import { describe, expect, it, vi } from 'vitest'
import { AgentSession, MAX_TOOL_ROUNDS } from '../../src/main/agent/session'
import { FakeConversation } from '../../src/main/agent/providers/fake'
import type { AgentEvent, ProviderConversation, StepResult, ToolOutcome } from '../../src/main/agent/types'
import type { ControlResult } from '../../src/main/control'

function harness(conversation: ProviderConversation, invokeImpl?: (a: string, p: unknown) => Promise<ControlResult>) {
  const events: AgentEvent[] = []
  const invoke = vi.fn(
    invokeImpl ??
      (async (action: string) =>
        action === 'screenshot'
          ? { ok: true, data: { imageBase64: 'PNGDATA' } }
          : { ok: true, data: { entityId: 'ent_1' } })
  )
  const session = new AgentSession(conversation, {
    invoke,
    emit: (e) => events.push(e),
    prepareImage: (png) => ({ base64: `jpeg(${png})`, mediaType: 'image/jpeg' })
  })
  return { session, events, invoke }
}

/** A conversation that replays canned steps and records tool results. */
class Scripted implements ProviderConversation {
  readonly results: ToolOutcome[][] = []
  readonly users: string[] = []
  constructor(private readonly steps: (() => StepResult)[]) {}
  addUserText(t: string): void {
    this.users.push(t)
  }
  async step(): Promise<StepResult> {
    const next = this.steps.shift()
    return next ? next() : { toolCalls: [], stop: 'end' }
  }
  addToolResults(r: ToolOutcome[]): void {
    this.results.push(r)
  }
}

describe('AgentSession', () => {
  it('runs text → tools → screenshot → answer against the control invoker', async () => {
    const conv = new FakeConversation()
    const { session, events, invoke } = harness(conv)
    await session.send('stage someone')

    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['add_entity', 'screenshot'])
    expect(invoke.mock.calls[0]![1]).toMatchObject({ assetId: 'person.woman', label: 'AGENT1' })
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('start')
    expect(types.at(-1)).toBe('done')
    expect(types).toContain('thinking-delta')
    const ends = events.filter((e): e is Extract<AgentEvent, { type: 'tool-end' }> => e.type === 'tool-end')
    expect(ends.map((e) => [e.ok, e.summary])).toEqual([
      [true, 'entityId ent_1'],
      [true, 'screenshot']
    ])
    expect(ends[1]!.imageDataUrl).toBe('data:image/jpeg;base64,jpeg(PNGDATA)')
    expect(conv.results[1]![0]!.image).toEqual({ base64: 'jpeg(PNGDATA)', mediaType: 'image/jpeg' })
    expect(events.at(-1)).toEqual({ type: 'done', usage: { input: 370, output: 23 } })
    expect(session.busy).toBe(false)
  })

  it('answers malformed and non-catalog tool calls with errors without touching the app', async () => {
    const conv = new Scripted([
      () => ({
        toolCalls: [
          { id: 'a', name: 'add_entity', args: null },
          { id: 'b', name: 'import_scan', args: { sourcePath: '/etc/passwd' } }
        ],
        stop: 'tools'
      })
    ])
    const { session, invoke } = harness(conv)
    await session.send('go')
    expect(invoke).not.toHaveBeenCalled()
    expect(conv.results[0]!.map((r) => r.ok)).toEqual([false, false])
    expect(conv.results[0]![1]!.text).toContain('Unknown tool')
  })

  it('pauses after the round limit, answering every call it made', async () => {
    const forever = () => ({ toolCalls: [{ id: 'x', name: 'get_state', args: {} }], stop: 'tools' as const })
    const conv = new Scripted(Array.from({ length: MAX_TOOL_ROUNDS + 5 }, () => forever))
    const { session, events } = harness(conv)
    await session.send('loop')
    expect(conv.results).toHaveLength(MAX_TOOL_ROUNDS)
    expect(events.some((e) => e.type === 'notice' && e.text.includes('Paused'))).toBe(true)
  })

  it('stops mid-turn and still answers the remaining calls as cancelled', async () => {
    const conv = new Scripted([
      () => ({
        toolCalls: [
          { id: '1', name: 'get_state', args: {} },
          { id: '2', name: 'play', args: {} }
        ],
        stop: 'tools'
      }),
      () => ({ toolCalls: [{ id: '3', name: 'stop', args: {} }], stop: 'tools' })
    ])
    let session!: AgentSession
    const h = harness(conv, async () => {
      session.stop()
      return { ok: true }
    })
    session = h.session
    await session.send('go')
    expect(h.invoke).toHaveBeenCalledTimes(1)
    expect(conv.results).toHaveLength(1)
    expect(conv.results[0]!.map((r) => r.ok)).toEqual([true, false])
    expect(conv.results[0]![1]!.text).toContain('Cancelled')
    expect(h.events.some((e) => e.type === 'notice' && e.text === 'Stopped.')).toBe(true)
  })

  it('reports provider errors and refuses a second message while busy', async () => {
    let release!: () => void
    const conv: ProviderConversation = {
      addUserText: () => {},
      addToolResults: () => {},
      step: () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('boom'))
        })
    }
    const { session, events } = harness(conv)
    const first = session.send('one')
    await session.send('two')
    expect(events.some((e) => e.type === 'error' && e.message.includes('still working'))).toBe(true)
    release()
    await first
    expect(events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message)).toContain('boom')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('truncates oversized tool results', async () => {
    const conv = new Scripted([() => ({ toolCalls: [{ id: 'g', name: 'get_state', args: {} }], stop: 'tools' })])
    const { session } = harness(conv, async () => ({ ok: true, data: 'x'.repeat(100_000) }))
    await session.send('big')
    expect(conv.results[0]![0]!.text.length).toBeLessThan(41_000)
    expect(conv.results[0]![0]!.text.endsWith('[truncated]')).toBe(true)
  })
})
