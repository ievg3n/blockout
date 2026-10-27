/**
 * Connections view of the Agent panel: Sign in with ChatGPT, API keys for
 * the key-based providers, and links to other AI apps. Keys are typed here
 * and handed straight to the main process, which encrypts them; the panel
 * only ever gets back "configured" and a ••••last4 hint.
 */

import { useState } from 'react'
import type { KeyProviderId, ProviderStatus } from '../../shared/agent'
import { useStore } from '../store'
import { PROVIDER_LABELS, useAgent } from '../ai/agent-store'
import { ExternalApps } from './ExternalApps'

const KEY_PROVIDERS: { id: KeyProviderId; url: string; placeholder: string }[] = [
  { id: 'anthropic', url: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'openai', url: 'https://platform.openai.com/api-keys', placeholder: 'sk-…' },
  { id: 'gemini', url: 'https://aistudio.google.com/apikey', placeholder: 'AIza…' },
  { id: 'minimax', url: 'https://platform.minimax.io/user-center/basic-information/interface-key', placeholder: 'MiniMax API key' },
  { id: 'openrouter', url: 'https://openrouter.ai/keys', placeholder: 'sk-or-…' }
]

const SOURCE_LABEL: Record<NonNullable<ProviderStatus['source']>, string> = {
  saved: 'saved',
  env: 'from environment',
  profile: 'from `ant auth login`'
}

function KeyRow({ id, url, placeholder }: (typeof KEY_PROVIDERS)[number]): JSX.Element {
  const status = useAgent((s) => s.config?.providers.find((p) => p.id === id))
  const { saveKey } = useAgent.getState()
  const toast = useStore((s) => s.toast)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (key: string | null): Promise<void> => {
    setBusy(true)
    try {
      await saveKey(id, key)
      setValue('')
      toast(key ? `${PROVIDER_LABELS[id]} key saved.` : `${PROVIDER_LABELS[id]} key removed.`, 'success')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="agent-key-row">
      <div className="agent-key-head">
        <b>{PROVIDER_LABELS[id]}</b>
        <span className={`agent-key-status${status?.configured ? ' on' : ''}`}>
          {status?.configured ? `${status.hint ?? ''} ${status.source ? SOURCE_LABEL[status.source] : ''}`.trim() : 'not connected'}
        </span>
      </div>
      <div className="field-row">
        <input
          type="password"
          value={value}
          placeholder={placeholder}
          aria-label={`${PROVIDER_LABELS[id]} API key`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) void save(value)
          }}
        />
        <button className="btn small" disabled={busy || !value.trim()} onClick={() => void save(value)}>
          Save
        </button>
        {status?.source === 'saved' && (
          <button className="btn small danger" disabled={busy} title="Remove the saved key" onClick={() => void save(null)}>
            ✕
          </button>
        )}
      </div>
      <a
        href="#"
        className="agent-link"
        onClick={(e) => {
          e.preventDefault()
          void window.blockout.openExternal(url)
        }}
      >
        Get a key ↗
      </a>
    </div>
  )
}

function ChatGPTSignIn(): JSX.Element {
  const status = useAgent((s) => s.config?.providers.find((p) => p.id === 'chatgpt'))
  const signingIn = useAgent((s) => s.signingIn)
  const { signIn, cancelSignIn, signOut } = useAgent.getState()
  const toast = useStore((s) => s.toast)

  return (
    <div className="panel-section">
      <div className="panel-title">Sign in with ChatGPT</div>
      <p className="agent-help">
        Run the agent on your ChatGPT Plus or Pro plan instead of an API key. Sign-in happens in your browser.
      </p>
      {status?.configured ? (
        <div className="field-row">
          <span className="agent-key-status on" style={{ flex: 1 }}>
            Signed in{status.hint ? ` as ${status.hint}` : ''}
          </span>
          <button
            className="btn small"
            onClick={async () => {
              const revoked = await signOut()
              toast(
                revoked
                  ? 'Signed out of ChatGPT.'
                  : 'Signed out locally — remote revocation was not confirmed. You can disconnect Blockout in ChatGPT Settings.',
                revoked ? 'success' : 'info'
              )
            }}
          >
            Sign out
          </button>
        </div>
      ) : signingIn ? (
        <div className="field-row">
          <span className="agent-help" style={{ flex: 1, margin: 0 }}>
            Waiting for the browser…
          </span>
          <button className="btn small" onClick={cancelSignIn}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="btn chatgpt-btn"
          onClick={async () => {
            const error = await signIn()
            toast(error ?? 'Signed in with ChatGPT.', error ? 'error' : 'success')
          }}
        >
          Continue with ChatGPT
        </button>
      )}
    </div>
  )
}

export function AiConnections(): JSX.Element {
  const encryptionAvailable = useAgent((s) => s.config?.encryptionAvailable ?? true)
  return (
    <div className="agent-connections">
      <ChatGPTSignIn />
      <div className="panel-section">
        <div className="panel-title">API keys</div>
        <p className="agent-help">
          Keys are stored {encryptionAvailable ? 'encrypted in your system keychain' : 'on this computer'} and are only sent
          to their provider.
        </p>
        {!encryptionAvailable && (
          <p className="agent-notice error">
            System encryption is unavailable, so keys are saved in plain text in Blockout's config folder.
          </p>
        )}
        {KEY_PROVIDERS.map((p) => (
          <KeyRow key={p.id} {...p} />
        ))}
      </div>
      <ExternalApps />
    </div>
  )
}
