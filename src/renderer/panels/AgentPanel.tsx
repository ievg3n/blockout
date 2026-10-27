/**
 * Agent panel — chat in the studio. The user describes a staging, camera,
 * or pose change; the model (Claude, ChatGPT, OpenAI, Gemini, MiniMax, or
 * OpenRouter) carries it out through the same control actions the MCP
 * bridge exposes, live in the viewport and undoable step by step.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { PROVIDER_IDS, type ProviderId } from '../../shared/agent'
import { PROVIDER_LABELS, useAgent, type ChatItem } from '../ai/agent-store'
import { AiConnections } from './AiConnections'

const SUGGESTED_MODELS: Partial<Record<ProviderId, string[]>> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
}

const EXAMPLES = [
  'Stage two actors facing each other 2 m apart and frame an over-the-shoulder shot.',
  'Make the selected person wave at 1 s and look up at 2 s.',
  'Add a slow 180° orbit around the hero and show me a screenshot.'
]

function ModelField(): JSX.Element {
  const config = useAgent((s) => s.config)
  const models = useAgent((s) => s.models)
  const modelsError = useAgent((s) => s.modelsError)
  const { setModel, loadModels } = useAgent.getState()
  const provider = config?.provider ?? 'anthropic'
  const current = config?.models[provider] ?? ''
  const [value, setValue] = useState(current)
  useEffect(() => {
    setValue(current)
  }, [current, provider])
  const options = [...new Set([...(SUGGESTED_MODELS[provider] ?? []), ...(models[provider] ?? [])])]
  const commit = (): void => {
    if (value.trim() && value.trim() !== current) void setModel(value.trim())
  }

  return (
    <div className="agent-model">
      <input
        type="text"
        list={`agent-models-${provider}`}
        value={value}
        placeholder="Model id — pick or type"
        aria-label="Model"
        title={modelsError ?? 'Model used for this provider'}
        onFocus={() => {
          if (!models[provider]) void loadModels(provider)
        }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      <datalist id={`agent-models-${provider}`}>
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}

function ToolChip({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }): JSX.Element {
  const icon = item.status === 'running' ? '…' : item.status === 'ok' ? '✓' : '✕'
  return (
    <div className={`agent-tool ${item.status}`}>
      <details>
        <summary>
          <span className="agent-tool-icon">{icon}</span>
          <code>{item.name}</code>
          {item.summary && <span className="agent-tool-summary">{item.summary}</span>}
        </summary>
        <pre>{item.args ? JSON.stringify(item.args, null, 2) : '(invalid arguments)'}</pre>
      </details>
      {item.image && <img className="agent-shot" src={item.image} alt="Viewport screenshot" />}
    </div>
  )
}

function Transcript(): JSX.Element {
  const items = useAgent((s) => s.items)
  const running = useAgent((s) => s.running)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items, running])

  return (
    <div className="agent-transcript" aria-live="polite">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="agent-msg user">
                {item.text}
              </div>
            )
          case 'assistant':
            return (
              <div key={item.id} className="agent-msg assistant">
                {item.thinking && (
                  <details className="agent-thinking">
                    <summary>Thinking</summary>
                    <p>{item.thinking}</p>
                  </details>
                )}
                {item.text}
              </div>
            )
          case 'tool':
            return <ToolChip key={item.id} item={item} />
          case 'notice':
            return (
              <div key={item.id} className={`agent-notice ${item.tone}`}>
                {item.text}
              </div>
            )
        }
      })}
      {running && <div className="agent-working">Working…</div>}
      <div ref={end} />
    </div>
  )
}

function Composer(): JSX.Element {
  const draft = useAgent((s) => s.draft)
  const running = useAgent((s) => s.running)
  const { setDraft, send, stop } = useAgent.getState()
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(draft)
    }
  }
  return (
    <div className="agent-composer">
      <textarea
        value={draft}
        rows={3}
        placeholder="Describe a staging, camera move, or pose…"
        aria-label="Message the agent"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {running ? (
        <button className="btn small danger" onClick={stop}>
          ■ Stop
        </button>
      ) : (
        <button className="btn small primary" disabled={!draft.trim()} onClick={() => void send(draft)}>
          Send ↵
        </button>
      )}
    </div>
  )
}

export function AgentPanel(): JSX.Element {
  const config = useAgent((s) => s.config)
  const view = useAgent((s) => s.view)
  const items = useAgent((s) => s.items)
  const { init, setProvider, setView, reset, send } = useAgent.getState()

  useEffect(() => {
    void init()
  }, [init])

  const provider = config?.provider ?? 'anthropic'
  const status = config?.providers.find((p) => p.id === provider)

  return (
    <div className="agent-panel">
      <div className="agent-header">
        <select
          value={provider}
          aria-label="AI provider"
          onChange={(e) => void setProvider(e.target.value as ProviderId)}
        >
          {PROVIDER_IDS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
              {config?.providers.find((s) => s.id === p)?.configured ? '' : ' — not connected'}
            </option>
          ))}
        </select>
        <ModelField />
        <div className="agent-header-actions">
          <button
            className={`btn small${view === 'connections' ? ' primary' : ''}`}
            title="Connections: sign in, API keys, other AI apps"
            onClick={() => setView(view === 'connections' ? 'chat' : 'connections')}
          >
            ⚙ Connections
          </button>
          <button className="btn small" title="Start a new conversation" disabled={items.length === 0} onClick={reset}>
            New chat
          </button>
        </div>
      </div>

      {view === 'connections' ? (
        <AiConnections />
      ) : (
        <>
          {items.length === 0 && (
            <div className="agent-empty">
              {status?.configured ? (
                <>
                  <p>Tell the agent what to block. It edits the open scene live — every step can be undone.</p>
                  {EXAMPLES.map((ex) => (
                    <button key={ex} className="agent-example" onClick={() => void send(ex)}>
                      {ex}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <p>
                    Connect <b>{PROVIDER_LABELS[provider]}</b> to start: sign in with ChatGPT or add an API key.
                  </p>
                  <button className="btn small primary" onClick={() => setView('connections')}>
                    Open Connections
                  </button>
                </>
              )}
            </div>
          )}
          <Transcript />
          <Composer />
        </>
      )}
    </div>
  )
}
