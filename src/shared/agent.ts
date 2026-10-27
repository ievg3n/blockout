/**
 * Agent panel types shared by the main process (src/main/agent), the
 * preload bridge, and the renderer: providers, streamed events, and the
 * credential-free config the panel renders.
 */

export type ProviderId = 'anthropic' | 'openai' | 'chatgpt' | 'gemini' | 'minimax' | 'openrouter'

export const PROVIDER_IDS: ProviderId[] = ['anthropic', 'chatgpt', 'openai', 'gemini', 'minimax', 'openrouter']

/** Providers that authenticate with a pasted API key (chatgpt uses sign-in). */
export type KeyProviderId = Exclude<ProviderId, 'chatgpt'>

export type AgentEvent =
  | { type: 'start'; turnId: string }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-start'; callId: string; name: string; args: Record<string, unknown> | null }
  | { type: 'tool-end'; callId: string; ok: boolean; summary: string; imageDataUrl?: string }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; usage?: { input: number; output: number } }

export interface ProviderStatus {
  id: ProviderId
  configured: boolean
  /** Last four characters of a saved key, or the signed-in account email. */
  hint?: string
  /** Where the credential comes from when it was not saved in the app. */
  source?: 'saved' | 'env' | 'profile'
}

export interface AgentConfig {
  provider: ProviderId
  models: Partial<Record<ProviderId, string>>
  providers: ProviderStatus[]
  /** false when Electron safeStorage cannot encrypt (keys stored in plain text). */
  encryptionAvailable: boolean
}
