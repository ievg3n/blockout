/**
 * Agent panel state: the chat transcript built from `agent:event`s, the
 * provider config (credential-free — keys never reach the renderer), and
 * the actions the panel calls. Kept apart from the document store: the
 * chat is session state, not part of the project.
 */

import { create } from 'zustand'
import type { AgentConfig, AgentEvent, KeyProviderId, ProviderId } from '../../shared/agent'

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string }
  | {
      kind: 'tool'
      id: string
      name: string
      args: Record<string, unknown> | null
      status: 'running' | 'ok' | 'error'
      summary?: string
      image?: string
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Claude (Anthropic)',
  chatgpt: 'ChatGPT (sign-in)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  minimax: 'MiniMax',
  openrouter: 'OpenRouter'
}

interface AgentState {
  config: AgentConfig | null
  items: ChatItem[]
  running: boolean
  view: 'chat' | 'connections'
  models: Partial<Record<ProviderId, string[]>>
  modelsError: string | null
  signingIn: boolean
  draft: string

  init(): Promise<void>
  setView(view: 'chat' | 'connections'): void
  setDraft(draft: string): void
  send(text: string): Promise<void>
  stop(): void
  reset(): void
  setProvider(provider: ProviderId): Promise<void>
  setModel(model: string): Promise<void>
  loadModels(provider: ProviderId): Promise<void>
  saveKey(provider: KeyProviderId, key: string | null): Promise<void>
  signIn(): Promise<string | null>
  cancelSignIn(): void
  signOut(): Promise<boolean>
}

let seq = 0
const nextId = (): string => `chat_${++seq}`
let unsubscribe: (() => void) | null = null

function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  const last = items[items.length - 1]
  switch (event.type) {
    case 'text-delta':
    case 'thinking-delta': {
      const key = event.type === 'text-delta' ? 'text' : 'thinking'
      if (last?.kind === 'assistant') {
        return [...items.slice(0, -1), { ...last, [key]: last[key] + event.text }]
      }
      return [...items, { kind: 'assistant', id: nextId(), text: '', thinking: '', [key]: event.text }]
    }
    case 'tool-start':
      return [...items, { kind: 'tool', id: event.callId, name: event.name, args: event.args, status: 'running' }]
    case 'tool-end':
      return items.map((it) =>
        it.kind === 'tool' && it.id === event.callId
          ? { ...it, status: event.ok ? 'ok' : 'error', summary: event.summary, image: event.imageDataUrl }
          : it
      )
    case 'notice':
      return [...items, { kind: 'notice', id: nextId(), text: event.text, tone: 'info' }]
    case 'error':
      return [...items, { kind: 'notice', id: nextId(), text: event.message, tone: 'error' }]
    default:
      return items
  }
}

export const useAgent = create<AgentState>((set, get) => ({
  config: null,
  items: [],
  running: false,
  view: 'chat',
  models: {},
  modelsError: null,
  signingIn: false,
  draft: '',

  async init() {
    if (!unsubscribe) {
      unsubscribe = window.blockout.onAgentEvent((event) => {
        if (event.type === 'start') set({ running: true })
        else if (event.type === 'done') set({ running: false })
        set({ items: applyEvent(get().items, event) })
      })
    }
    const config = await window.blockout.agentGetConfig()
    set({ config })
  },

  setView: (view) => set({ view }),
  setDraft: (draft) => set({ draft }),

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed || get().running) return
    set({ items: [...get().items, { kind: 'user', id: nextId(), text: trimmed }], running: true, draft: '' })
    const res = await window.blockout.agentSend(trimmed)
    if (!res.ok) {
      set({
        running: false,
        items: [...get().items, { kind: 'notice', id: nextId(), text: res.error ?? 'Could not start the agent.', tone: 'error' }]
      })
    }
  },

  stop() {
    void window.blockout.agentStop()
  },

  reset() {
    void window.blockout.agentReset()
    set({ items: [], running: false })
  },

  async setProvider(provider) {
    const config = await window.blockout.agentSetProvider(provider)
    set({ config, items: [], running: false, modelsError: null })
  },

  async setModel(model) {
    const provider = get().config?.provider
    if (!provider) return
    const config = await window.blockout.agentSetProvider(provider, model)
    set({ config })
  },

  async loadModels(provider) {
    set({ modelsError: null })
    try {
      const ids = await window.blockout.agentListModels(provider)
      set({ models: { ...get().models, [provider]: ids } })
    } catch (e) {
      const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      set({ modelsError: message })
    }
  },

  async saveKey(provider, key) {
    const config = await window.blockout.agentSetKey(provider, key)
    set({ config, models: { ...get().models, [provider]: undefined } })
  },

  async signIn() {
    set({ signingIn: true })
    try {
      const res = await window.blockout.agentChatGPTSignIn()
      set({ config: res.config })
      return res.ok ? null : (res.error ?? 'Sign-in failed.')
    } finally {
      set({ signingIn: false })
    }
  },

  cancelSignIn() {
    void window.blockout.agentChatGPTCancel()
  },

  async signOut() {
    const res = await window.blockout.agentChatGPTSignOut()
    set({ config: res.config, models: { ...get().models, chatgpt: undefined } })
    return res.revoked
  }
}))
