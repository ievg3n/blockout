/**
 * Main-process agent types: the provider-conversation contract the session
 * loop drives. UI-facing types (providers, events, config) live in
 * src/shared/agent.ts and are re-exported here.
 */

export type {
  AgentConfig,
  AgentEvent,
  KeyProviderId,
  ProviderId,
  ProviderStatus
} from '../../shared/agent'
export { PROVIDER_IDS } from '../../shared/agent'

export interface ToolCall {
  id: string
  name: string
  /** Parsed arguments, or null when the model produced unparseable JSON. */
  args: Record<string, unknown> | null
}

export interface ToolOutcome {
  call: ToolCall
  ok: boolean
  /** JSON text handed back to the model. */
  text: string
  /** Screenshot attached to the result (JPEG, base64). */
  image?: { base64: string; mediaType: 'image/jpeg' | 'image/png' }
}

export interface StepResult {
  toolCalls: ToolCall[]
  /** Why the model stopped: `tools` means toolCalls must be answered. */
  stop: 'end' | 'tools' | 'max_tokens' | 'refusal'
  usage?: { input: number; output: number }
}

export interface StepCallbacks {
  signal: AbortSignal
  onText: (delta: string) => void
  onThinking?: (delta: string) => void
}

/**
 * One provider-native conversation. History is append-only: the session
 * adds the user's text, runs steps, and answers EVERY tool call a step
 * returned (even on abort) before the next step or user message.
 */
export interface ProviderConversation {
  addUserText(text: string): void
  step(cb: StepCallbacks): Promise<StepResult>
  addToolResults(results: ToolOutcome[]): void
}
