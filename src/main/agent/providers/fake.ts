/**
 * Scripted provider for end-to-end tests (BLOCKOUT_AGENT_FAKE=1): no
 * network, deterministic. Each user message runs the same script — a
 * short reply, add_entity, screenshot, and a closing line — so tests can
 * assert that the panel, the tool loop, and the live store all line up.
 */

import type { ProviderConversation, StepCallbacks, StepResult, ToolOutcome } from '../types'

export class FakeConversation implements ProviderConversation {
  private stage = 0
  private turn = 0
  readonly results: ToolOutcome[][] = []

  addUserText(): void {
    this.stage = 0
    this.turn++
  }

  async step(cb: StepCallbacks): Promise<StepResult> {
    await new Promise((r) => setTimeout(r, 150))
    if (cb.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const n = this.turn
    switch (this.stage++) {
      case 0:
        cb.onThinking?.('Planning the staging.')
        cb.onText('Adding an actor. ')
        return {
          toolCalls: [
            { id: `fake_${n}_1`, name: 'add_entity', args: { assetId: 'person.woman', x: 1, z: -2, label: `AGENT${n}` } }
          ],
          stop: 'tools',
          usage: { input: 100, output: 10 }
        }
      case 1:
        return {
          toolCalls: [{ id: `fake_${n}_2`, name: 'screenshot', args: {} }],
          stop: 'tools',
          usage: { input: 120, output: 5 }
        }
      default:
        cb.onText(`Done — AGENT${n} is on set.`)
        return { toolCalls: [], stop: 'end', usage: { input: 150, output: 8 } }
    }
  }

  addToolResults(results: ToolOutcome[]): void {
    this.results.push(results)
  }
}
