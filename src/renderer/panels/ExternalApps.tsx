/**
 * "Other AI apps" section of Connections: drive Blockout from Claude
 * Desktop (one-click .mcpb extension), Claude Code / other MCP clients
 * (paste-ready config), or ChatGPT and claude.ai (remote connector through
 * an ngrok tunnel — off by default, never remembered as on).
 */

import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useAgent } from '../ai/agent-store'

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => useStore.getState().toast(`${what} copied.`, 'success'),
    () => useStore.getState().toast('Could not copy to the clipboard.', 'error')
  )
}

function ExternalLink({ url, children }: { url: string; children: string }): JSX.Element {
  return (
    <a
      href="#"
      className="agent-link"
      onClick={(e) => {
        e.preventDefault()
        void window.blockout.openExternal(url)
      }}
    >
      {children}
    </a>
  )
}

function ClaudeDesktop(): JSX.Element {
  const connect = useAgent((s) => s.connect)
  const toast = useStore((s) => s.toast)
  const [showManual, setShowManual] = useState(false)

  return (
    <div className="connect-card">
      <b>Claude Desktop</b>
      <p className="agent-help">
        Installs the Blockout extension in the Claude app — no Node or terminal needed. Keep Blockout open with a project, then
        ask Claude to stage your scene.
      </p>
      <div className="field-row">
        <button
          className="btn small primary"
          disabled={!connect?.bundleExists}
          onClick={async () => {
            const res = await window.blockout.installClaudeDesktop()
            toast(res.ok ? 'Opening Claude Desktop — confirm the install there.' : (res.error ?? 'Could not open Claude Desktop.'), res.ok ? 'success' : 'error')
          }}
        >
          Install in Claude Desktop
        </button>
        <button className="btn small" disabled={!connect?.bundleExists} onClick={() => void window.blockout.revealClaudeDesktopExtension()}>
          Show file
        </button>
      </div>
      {connect && !connect.bundleExists && <p className="agent-notice error">Extension not built — run `npm run build:mcpb`.</p>}
      <button className="agent-disclosure" onClick={() => setShowManual(!showManual)}>
        {showManual ? '▾' : '▸'} Claude Code / manual setup
      </button>
      {showManual && connect && (
        <div className="connect-manual">
          <div className="field">
            <label>Claude Code</label>
            <pre className="connect-snippet">{connect.claudeCodeCommand}</pre>
            <button className="btn small" onClick={() => copy(connect.claudeCodeCommand, 'Command')}>
              Copy command
            </button>
          </div>
          <div className="field">
            <label>claude_desktop_config.json · Codex · other MCP clients</label>
            <pre className="connect-snippet">{connect.desktopConfig}</pre>
            <button className="btn small" onClick={() => copy(connect.desktopConfig, 'Config')}>
              Copy config
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ChatGPTConnector(): JSX.Element {
  const remote = useAgent((s) => s.remote)
  const { remoteStart, remoteStop, remoteRotate } = useAgent.getState()
  const [domain, setDomain] = useState(remote.domain ?? '')
  useEffect(() => {
    if (remote.domain !== undefined) setDomain(remote.domain)
  }, [remote.domain])
  const busy = remote.status === 'starting'

  return (
    <div className="connect-card">
      <b>ChatGPT · claude.ai (remote connector)</b>
      <p className="agent-help">
        ChatGPT only connects to apps over public HTTPS, so Blockout publishes a private link through <b>ngrok</b>. Anyone
        with the link can edit your open scene while this is on — tools that read files on your disk are disabled.
      </p>
      <div className="field">
        <label htmlFor="ngrok-domain">Your fixed ngrok domain (optional — keeps the same link)</label>
        <input
          id="ngrok-domain"
          type="text"
          value={domain}
          placeholder="your-name.ngrok-free.app"
          spellCheck={false}
          disabled={remote.status === 'online' || busy}
          onChange={(e) => setDomain(e.target.value)}
        />
      </div>
      <div className="field-row">
        {remote.status === 'online' ? (
          <button className="btn small danger" onClick={() => void remoteStop()}>
            ■ Stop remote access
          </button>
        ) : (
          <button className="btn small primary" disabled={busy} onClick={() => void remoteStart(domain)}>
            {busy ? 'Starting…' : 'Start remote access'}
          </button>
        )}
        <button
          className="btn small"
          title="Make a new secret link; connectors using the old link stop working"
          onClick={() => void remoteRotate()}
        >
          New link
        </button>
      </div>

      {remote.status === 'error' && remote.error && (
        <div className="agent-notice error connect-error">
          {remote.error.message}
          {remote.error.code === 'auth' && (
            <>
              {' '}
              <ExternalLink url="https://dashboard.ngrok.com/get-started/your-authtoken">Get your authtoken ↗</ExternalLink>
            </>
          )}
          {remote.error.code === 'missing' && (
            <>
              {' '}
              <ExternalLink url="https://ngrok.com/download">Download ngrok ↗</ExternalLink>
            </>
          )}
        </div>
      )}

      {remote.status === 'online' && remote.url && (
        <>
          <div className="field">
            <label>
              <span className="remote-dot" /> Online — connector URL
            </label>
            <pre className="connect-snippet" data-testid="remote-url">
              {remote.url}
            </pre>
            <button className="btn small" onClick={() => copy(remote.url!, 'Connector URL')}>
              Copy URL
            </button>
          </div>
          <ol className="connect-steps">
            <li>ChatGPT → Settings → Apps &amp; Connectors → Advanced → turn on Developer mode.</li>
            <li>Create a connector, paste the URL, choose “No authentication”.</li>
            <li>In a chat, enable the Blockout connector and ask it to stage your scene.</li>
            <li>claude.ai works the same way: Settings → Connectors → Add custom connector.</li>
          </ol>
          {remote.activity.length > 0 && (
            <div className="field">
              <label>Recent calls</label>
              <ul className="remote-activity">
                {remote.activity.map((a) => (
                  <li key={`${a.at}-${a.tool}`} className={a.ok ? 'ok' : 'error'}>
                    <code>{a.tool}</code> <span>{new Date(a.at).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function ExternalApps(): JSX.Element {
  const { initRemote } = useAgent.getState()
  useEffect(() => {
    void initRemote()
  }, [initRemote])

  return (
    <div className="panel-section">
      <div className="panel-title">Other AI apps</div>
      <ClaudeDesktop />
      <ChatGPTConnector />
    </div>
  )
}
