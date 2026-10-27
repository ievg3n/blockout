/**
 * Remote access manager (Connections → ChatGPT): owns the remote MCP server,
 * the ngrok tunnel, and the persistent connector secret, and reports state
 * to the renderer over `remote:*`. Always starts OFF.
 */

import { app, ipcMain, type BrowserWindow } from 'electron'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { resolveConfigPath } from '../shared/config-paths'
import type { RemoteActivity, RemoteState } from '../shared/agent'
import type { ControlInvoke } from './control'
import { newRemoteSecret, startRemoteMcpServer, type RemoteMcpServer } from './remote-mcp'
import { NgrokTunnel, TunnelError } from './tunnel'

const FILE = resolveConfigPath('remote-mcp.json')
const MAX_ACTIVITY = 10

interface Saved {
  secret: string
  ngrokDomain?: string
}

async function load(): Promise<Saved> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf-8')) as Partial<Saved>
    if (typeof parsed.secret === 'string' && /^[0-9a-f]{64}$/.test(parsed.secret)) {
      return { secret: parsed.secret, ngrokDomain: parsed.ngrokDomain }
    }
  } catch {
    // First use.
  }
  return { secret: newRemoteSecret() }
}

async function save(data: Saved): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, FILE)
}

export function registerRemoteIpc(opts: { invoke: ControlInvoke; getWindow: () => BrowserWindow | null }): void {
  const noTunnel = process.env.BLOCKOUT_REMOTE_NO_TUNNEL === '1'
  const tunnel = new NgrokTunnel()
  let saved: Saved | null = null
  let server: RemoteMcpServer | null = null
  let publicBase: string | null = null
  let state: RemoteState = { status: 'off', activity: [] }

  const savedData = async (): Promise<Saved> => (saved ??= await load())

  const connectorUrl = (base: string, secret: string): string => `${base.replace(/\/$/, '')}/mcp/${secret}`

  const publish = (patch: Partial<RemoteState>): RemoteState => {
    state = { ...state, ...patch }
    opts.getWindow()?.webContents.send('remote:state', state)
    return state
  }

  const withDomain = async (): Promise<RemoteState> => {
    const data = await savedData()
    return { ...state, domain: data.ngrokDomain }
  }

  async function stop(): Promise<RemoteState> {
    tunnel.stop()
    publicBase = null
    const s = server
    server = null
    await s?.close()
    return publish({ status: 'off', url: undefined, error: undefined })
  }

  async function start(domain?: string): Promise<RemoteState> {
    const data = await savedData()
    if (typeof domain === 'string') {
      const clean = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      data.ngrokDomain = clean || undefined
      await save(data)
    } else if (!saved) {
      await save(data)
    }
    publish({ status: 'starting', error: undefined, url: undefined, domain: data.ngrokDomain })
    try {
      server ??= await startRemoteMcpServer({
        getSecret: () => saved?.secret ?? '',
        invoke: opts.invoke,
        onActivity: (tool, ok) => {
          const entry: RemoteActivity = { tool, ok, at: Date.now() }
          publish({ activity: [entry, ...state.activity].slice(0, MAX_ACTIVITY) })
        }
      })
      if (noTunnel) {
        publicBase = `http://127.0.0.1:${server.port}`
      } else {
        publicBase = await tunnel.start(server.port, data.ngrokDomain, (err) => {
          // The tunnel died after coming online: take the endpoint down too.
          void stop().then(() => publish({ status: 'error', error: { code: err.code, message: err.message } }))
        })
      }
      return publish({ status: 'online', url: connectorUrl(publicBase, data.secret) })
    } catch (e) {
      await stop()
      const err = e instanceof TunnelError ? e : new TunnelError('other', e instanceof Error ? e.message : String(e))
      return publish({ status: 'error', error: { code: err.code, message: err.message } })
    }
  }

  ipcMain.handle('remote:status', () => withDomain())
  ipcMain.handle('remote:start', (_e, domain?: unknown) => start(typeof domain === 'string' ? domain : undefined))
  ipcMain.handle('remote:stop', () => stop())
  ipcMain.handle('remote:rotate', async () => {
    const data = await savedData()
    data.secret = newRemoteSecret()
    await save(data)
    return publish({ url: publicBase ? connectorUrl(publicBase, data.secret) : undefined })
  })

  app.on('will-quit', () => {
    tunnel.stop()
    void server?.close()
  })
}
