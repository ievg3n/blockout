/**
 * Sign in with ChatGPT (open-source token sharing) — lets a ChatGPT Plus /
 * Pro user run the agent on their plan instead of an API key. Contract per
 * developers.openai.com/siwc/token-sharing-open-source:
 *
 * - Authorization code + PKCE (S256) against auth.openai.com with an HTTP
 *   loopback redirect on 127.0.0.1 (only the port may vary).
 * - First sign-in registers with client_id=dynamic_agent_client; the
 *   callback returns the issued `oaiapp_…` client id, reused afterwards.
 * - Plan usage needs the granted scope `chatgpt.tokens.use.direct`.
 * - Access tokens last an hour; refresh tokens rotate (serialized here).
 */

import { createHash, randomBytes } from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'
import type { ChatGPTCredential } from './credentials'

export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
export const OPENID_CONFIG_URL = 'https://auth.openai.com/.well-known/openid-configuration'
export const API_RESOURCE = 'https://api.openai.com/v1'
export const REGISTRATION_CLIENT_ID = 'dynamic_agent_client'
export const AGENT_NAME_HINT = 'Blockout'
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
const CALLBACK_PATH = '/auth/callback'
const PREFERRED_PORT = 1455
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 2 * 60_000

type Fetch = typeof fetch

const b64url = (buf: Buffer): string => buf.toString('base64url')

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthorizeUrl(p: {
  clientId?: string
  hostId: string
  redirectUri: string
  state: string
  nonce: string
  challenge: string
  loginHint?: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  const q = url.searchParams
  q.set('client_id', p.clientId ?? REGISTRATION_CLIENT_ID)
  // agent_name_hint is sent on the initial dynamic registration only.
  if (!p.clientId) q.set('agent_name_hint', AGENT_NAME_HINT)
  q.set('ext_agent_host_id', p.hostId)
  q.set('response_type', 'code')
  q.set('redirect_uri', p.redirectUri)
  q.set('scope', SCOPES)
  q.set('resource', API_RESOURCE)
  q.set('state', p.state)
  q.set('nonce', p.nonce)
  q.set('code_challenge', p.challenge)
  q.set('code_challenge_method', 'S256')
  if (p.loginHint) q.set('login_hint', p.loginHint)
  return url.toString()
}

/** Validate the loopback callback; returns the code and the client id to exchange with. */
export function parseCallback(
  params: URLSearchParams,
  expected: { state: string; clientId?: string }
): { code: string; clientId: string } {
  if (params.get('state') !== expected.state) throw new Error('Sign-in failed: the response did not match this request.')
  const error = params.get('error')
  if (error === 'access_denied') throw new Error('Sign-in was cancelled.')
  if (error) throw new Error(`Sign-in failed: ${params.get('error_description') ?? error}`)
  const code = params.get('code')
  if (!code) throw new Error('Sign-in failed: no authorization code was returned.')
  const returned = params.get('client_id') ?? undefined
  if (expected.clientId && returned && returned !== expected.clientId) {
    throw new Error('Sign-in failed: ChatGPT returned a different app registration.')
  }
  const clientId = expected.clientId ?? returned
  if (!clientId || clientId === REGISTRATION_CLIENT_ID) {
    throw new Error('Sign-in failed: ChatGPT did not issue a client id for Blockout.')
  }
  return { code, clientId }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
}

/** Claims from an ID token received directly from the token endpoint over TLS. */
export function idTokenClaims(idToken: string | undefined): Record<string, unknown> {
  if (!idToken) return {}
  const payload = idToken.split('.')[1]
  if (!payload) return {}
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function credentialFromTokens(
  tokens: TokenResponse,
  clientId: string,
  previous?: ChatGPTCredential,
  nonce?: string,
  now = Date.now()
): ChatGPTCredential {
  const scope = tokens.scope ?? previous?.scope ?? ''
  if (!scope.split(/\s+/).includes(PLAN_SCOPE)) {
    throw new Error(
      'This ChatGPT account did not grant plan usage to Blockout. Plan usage needs an eligible ChatGPT Plus or Pro plan.'
    )
  }
  const claims = idTokenClaims(tokens.id_token)
  if (nonce && tokens.id_token && claims.nonce !== nonce) throw new Error('Sign-in failed: the ID token did not match this request.')
  const sub = typeof claims.sub === 'string' ? claims.sub : previous?.sub
  if (previous?.sub && sub !== previous.sub) throw new Error('The refreshed sign-in belongs to a different ChatGPT account.')
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken
  if (!refreshToken) throw new Error('Sign-in failed: no refresh token was issued.')
  return {
    clientId,
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
    scope,
    sub,
    email: typeof claims.email === 'string' ? claims.email : previous?.email
  }
}

async function postForm(fetchImpl: Fetch, url: string, form: Record<string, string>): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString()
  })
}

async function tokenRequest(fetchImpl: Fetch, form: Record<string, string>): Promise<TokenResponse> {
  const res = await postForm(fetchImpl, TOKEN_URL, form)
  const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string }
  if (!res.ok || !body.access_token) {
    const err = new Error(body.error_description ?? body.error ?? `Token request failed (${res.status}).`)
    ;(err as Error & { code?: string }).code = body.error
    throw err
  }
  return body
}

/** Listen on the loopback callback (preferring port 1455) before the browser opens. */
async function listenLoopback(): Promise<{ server: http.Server; redirectUri: string }> {
  const server = http.createServer()
  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  try {
    await listen(PREFERRED_PORT)
  } catch {
    await listen(0)
  }
  const { port } = server.address() as AddressInfo
  return { server, redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}` }
}

const PAGE = (msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Blockout</title><body style="font:16px system-ui;background:#111113;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>${msg}</p></body>`

export interface SignInOptions {
  hostId: string
  previous?: ChatGPTCredential
  openBrowser: (url: string) => Promise<void>
  fetchImpl?: Fetch
  signal?: AbortSignal
}

/** Run the whole browser sign-in; resolves with a validated credential. */
export async function signInWithChatGPT(opts: SignInOptions): Promise<ChatGPTCredential> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const { verifier, challenge } = createPkce()
  const state = b64url(randomBytes(16))
  const nonce = b64url(randomBytes(16))
  const { server, redirectUri } = await listenLoopback()
  const expectedClient = opts.previous?.clientId

  try {
    const params = await new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out — try again.')), SIGN_IN_TIMEOUT_MS)
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('Sign-in was cancelled.'))
      })
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end()
          return
        }
        const ok = url.searchParams.get('state') === state && !url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PAGE(ok ? 'Signed in — you can close this tab and return to Blockout.' : 'Sign-in did not complete. Return to Blockout and try again.'))
        clearTimeout(timer)
        resolve(url.searchParams)
      })
      opts
        .openBrowser(
          buildAuthorizeUrl({
            clientId: expectedClient,
            hostId: opts.hostId,
            redirectUri,
            state,
            nonce,
            challenge,
            loginHint: opts.previous?.email
          })
        )
        .catch(reject)
    })

    const { code, clientId } = parseCallback(params, { state, clientId: expectedClient })
    const tokens = await tokenRequest(fetchImpl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: API_RESOURCE
    })
    // A different account signing in again starts a fresh identity.
    const sameAccount = opts.previous && idTokenClaims(tokens.id_token).sub === opts.previous.sub
    return credentialFromTokens(tokens, clientId, sameAccount ? opts.previous : undefined, nonce)
  } finally {
    server.close()
  }
}

export async function refreshChatGPT(cred: ChatGPTCredential, fetchImpl: Fetch = fetch): Promise<ChatGPTCredential> {
  const tokens = await tokenRequest(fetchImpl, {
    grant_type: 'refresh_token',
    client_id: cred.clientId,
    refresh_token: cred.refreshToken,
    resource: API_RESOURCE
  })
  return credentialFromTokens(tokens, cred.clientId, cred)
}

/** Revoke the refresh token. Resolves true when revocation was confirmed. */
export async function revokeChatGPT(cred: ChatGPTCredential, fetchImpl: Fetch = fetch): Promise<boolean> {
  try {
    const config = (await (await fetchImpl(OPENID_CONFIG_URL)).json()) as { revocation_endpoint?: string }
    if (!config.revocation_endpoint) return false
    const res = await postForm(fetchImpl, config.revocation_endpoint, {
      token: cred.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: cred.clientId
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Hands out a fresh access token, refreshing near expiry. Refreshes are
 * serialized: refresh tokens rotate, so two concurrent refreshes would
 * invalidate each other.
 */
export class ChatGPTTokenSource {
  private inflight: Promise<ChatGPTCredential> | null = null

  constructor(
    private readonly load: () => ChatGPTCredential | undefined,
    private readonly save: (cred: ChatGPTCredential) => Promise<void>,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  async accessToken(now = Date.now()): Promise<string> {
    const cred = this.load()
    if (!cred) throw new Error('Not signed in with ChatGPT — open Connections to sign in.')
    if (cred.expiresAt - REFRESH_MARGIN_MS > now) return cred.accessToken
    this.inflight ??= refreshChatGPT(cred, this.fetchImpl)
      .then(async (next) => {
        await this.save(next)
        return next
      })
      .finally(() => {
        this.inflight = null
      })
    try {
      return (await this.inflight).accessToken
    } catch (e) {
      const code = (e as Error & { code?: string }).code
      if (code === 'invalid_grant') throw new Error('Your ChatGPT sign-in expired — sign in again in Connections.')
      throw e
    }
  }
}
