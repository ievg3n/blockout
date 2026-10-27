/**
 * ngrok tunnel for the remote MCP endpoint. Blockout does not ship ngrok:
 * it finds the user's install, runs `ngrok http` against the local port
 * (optionally on their fixed domain), and reads the public URL from the
 * agent's JSON log. Failures come back as a code the UI can explain:
 * not installed, no authtoken, domain problem, or anything else.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { terminateProcessTree } from './ffmpeg'

export type TunnelErrorCode = 'missing' | 'auth' | 'domain' | 'outdated' | 'other'

export class TunnelError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TunnelError'
  }
}

const START_TIMEOUT_MS = 25_000

/** Locate the ngrok binary: PATH first, then the usual install spots (GUI apps get a thin PATH). */
export function findNgrok(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const exe = platform === 'win32' ? 'ngrok.exe' : 'ngrok'
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    dirs.push(join(local, 'Microsoft', 'WinGet', 'Links'), join(local, 'ngrok'), 'C:\\ProgramData\\chocolatey\\bin')
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', join(homedir(), '.local', 'bin'))
  }
  for (const dir of dirs) {
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Map an ngrok log/error line to a user-facing failure, or null if it is not one. */
export function classifyNgrokError(text: string): TunnelError | null {
  if (/ERR_NGROK_4018|authtoken|authentication failed/i.test(text)) {
    return new TunnelError('auth', 'ngrok needs your authtoken. Sign up at ngrok.com, then run `ngrok config add-authtoken <token>` in a terminal.')
  }
  if (/unknown flag: --url/i.test(text)) {
    return new TunnelError('outdated', 'Your ngrok is too old for fixed domains — run `ngrok update`.')
  }
  if (/ERR_NGROK_(313|314|315|319|320|326|3200)|domain|endpoint .* is already online/i.test(text)) {
    return new TunnelError('domain', `ngrok could not use that domain: ${text.trim().slice(0, 240)}`)
  }
  if (/ERR_NGROK_\d+/.test(text)) return new TunnelError('other', `ngrok: ${text.trim().slice(0, 240)}`)
  return null
}

export function ngrokArgs(port: number, domain?: string): string[] {
  const args = ['http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'json']
  const host = domain?.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (host) args.push('--url', `https://${host}`)
  return args
}

export class NgrokTunnel {
  private proc: ChildProcess | null = null

  get running(): boolean {
    return this.proc !== null
  }

  /** Start ngrok; resolves with the public https URL. */
  start(port: number, domain?: string, onExit?: (error: TunnelError) => void): Promise<string> {
    const bin = findNgrok()
    if (!bin) {
      return Promise.reject(
        new TunnelError('missing', 'ngrok is not installed. Install it with `brew install ngrok` (macOS) or `winget install ngrok.ngrok` (Windows).')
      )
    }
    this.stop()
    const proc = spawn(bin, ngrokArgs(port, domain), { windowsHide: true })
    this.proc = proc

    return new Promise((resolve, reject) => {
      let settled = false
      let tail = ''
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const fail = (err: TunnelError): void =>
        settle(() => {
          this.stop()
          reject(err)
        })
      const timer = setTimeout(() => fail(new TunnelError('other', 'ngrok did not come online in time — check your network.')), START_TIMEOUT_MS)

      const onLine = (line: string): void => {
        tail = (tail + '\n' + line).slice(-2000)
        let entry: Record<string, unknown> | null = null
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          // Plain-text line (stderr or pre-logger output).
        }
        if (entry && entry.msg === 'started tunnel' && typeof entry.url === 'string' && entry.url.startsWith('https://')) {
          settle(() => resolve(entry.url as string))
          return
        }
        const text = entry ? [entry.msg, entry.err].filter((v) => typeof v === 'string').join(': ') : line
        const isError = !entry || entry.lvl === 'eror' || entry.lvl === 'crit' || typeof entry.err === 'string'
        const classified = isError ? classifyNgrokError(text) : null
        if (classified) {
          if (settled) onExit?.(classified)
          else fail(classified)
        }
      }

      let buf = ''
      const feed = (chunk: Buffer): void => {
        buf += chunk.toString('utf-8')
        let idx
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (line) onLine(line)
        }
      }
      proc.stdout?.on('data', feed)
      proc.stderr?.on('data', feed)
      proc.once('error', (e) => fail(new TunnelError('other', `Could not run ngrok: ${e.message}`)))
      proc.once('exit', (code) => {
        if (this.proc === proc) this.proc = null
        const err = classifyNgrokError(tail) ?? new TunnelError('other', `ngrok exited (code ${code ?? '?'}).`)
        if (!settled) fail(err)
        else onExit?.(err)
      })
    })
  }

  stop(): void {
    const proc = this.proc
    this.proc = null
    if (proc && proc.exitCode === null) void terminateProcessTree(proc)
  }
}
