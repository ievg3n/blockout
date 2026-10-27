import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  ChatGPTTokenSource,
  PLAN_SCOPE,
  REGISTRATION_CLIENT_ID,
  buildAuthorizeUrl,
  createPkce,
  credentialFromTokens,
  parseCallback
} from '../../src/main/agent/chatgpt-auth'
import { CredentialStore, keyHint, type ChatGPTCredential, type Cipher } from '../../src/main/agent/credentials'

const jwt = (claims: Record<string, unknown>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`

describe('Sign in with ChatGPT', () => {
  it('derives an S256 PKCE challenge without padding', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(challenge).not.toContain('=')
  })

  it('registers on first sign-in and reuses the issued client id afterwards', () => {
    const base = { hostId: 'host-1', redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 's', nonce: 'n', challenge: 'c' }
    const first = new URL(buildAuthorizeUrl(base)).searchParams
    expect(first.get('client_id')).toBe(REGISTRATION_CLIENT_ID)
    expect(first.get('agent_name_hint')).toBe('Blockout')
    expect(first.get('scope')).toBe(SCOPE)
    expect(first.get('resource')).toBe('https://api.openai.com/v1')
    expect(first.get('code_challenge_method')).toBe('S256')
    expect(first.get('ext_agent_host_id')).toBe('host-1')
    const again = new URL(buildAuthorizeUrl({ ...base, clientId: 'oaiapp_1', loginHint: 'a@b.c' })).searchParams
    expect(again.get('client_id')).toBe('oaiapp_1')
    expect(again.has('agent_name_hint')).toBe(false)
    expect(again.get('login_hint')).toBe('a@b.c')
  })

  it('validates the loopback callback', () => {
    const q = (o: Record<string, string>) => new URLSearchParams(o)
    expect(parseCallback(q({ state: 's', code: 'k', client_id: 'oaiapp_9' }), { state: 's' })).toEqual({
      code: 'k',
      clientId: 'oaiapp_9'
    })
    // Reauthorization may omit client_id.
    expect(parseCallback(q({ state: 's', code: 'k' }), { state: 's', clientId: 'oaiapp_9' }).clientId).toBe('oaiapp_9')
    expect(() => parseCallback(q({ state: 'x', code: 'k' }), { state: 's' })).toThrow(/did not match/)
    expect(() => parseCallback(q({ state: 's', error: 'access_denied' }), { state: 's' })).toThrow(/cancelled/)
    expect(() => parseCallback(q({ state: 's', code: 'k', client_id: 'oaiapp_2' }), { state: 's', clientId: 'oaiapp_1' })).toThrow(
      /different app registration/
    )
    expect(() => parseCallback(q({ state: 's', code: 'k' }), { state: 's' })).toThrow(/client id/)
  })

  it('requires the plan scope and a matching identity', () => {
    const now = 1_000_000
    const cred = credentialFromTokens(
      { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: SCOPE, id_token: jwt({ sub: 'u1', email: 'e@x', nonce: 'n' }) },
      'oaiapp_1',
      undefined,
      'n',
      now
    )
    expect(cred).toEqual({
      clientId: 'oaiapp_1',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: now + 3_600_000,
      scope: SCOPE,
      sub: 'u1',
      email: 'e@x'
    })
    expect(() => credentialFromTokens({ access_token: 'a', refresh_token: 'r', scope: 'openid' }, 'c')).toThrow(/plan usage/)
    expect(() =>
      credentialFromTokens({ access_token: 'a', refresh_token: 'r', scope: SCOPE, id_token: jwt({ nonce: 'other' }) }, 'c', undefined, 'n')
    ).toThrow(/did not match/)
    expect(() =>
      credentialFromTokens({ access_token: 'a', scope: SCOPE, id_token: jwt({ sub: 'u2' }) }, 'c', cred)
    ).toThrow(/different ChatGPT account/)
  })

  it('refreshes near expiry exactly once for concurrent callers and keeps the rotated token', async () => {
    let cred: ChatGPTCredential = {
      clientId: 'oaiapp_1',
      accessToken: 'old',
      refreshToken: 'r1',
      expiresAt: Date.now() + 30_000,
      scope: SCOPE,
      sub: 'u1'
    }
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body))
      expect(form.get('grant_type')).toBe('refresh_token')
      expect(form.get('client_id')).toBe('oaiapp_1')
      expect(form.get('refresh_token')).toBe('r1')
      expect(form.has('scope')).toBe(false)
      return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600, scope: SCOPE }))
    })
    const source = new ChatGPTTokenSource(
      () => cred,
      async (c) => {
        cred = c
      },
      fetchImpl as unknown as typeof fetch
    )
    const [a, b] = await Promise.all([source.accessToken(), source.accessToken()])
    expect([a, b]).toEqual(['new', 'new'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(cred.refreshToken).toBe('r2')
    expect(await source.accessToken()).toBe('new')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('asks for a new sign-in when the refresh grant is rejected', async () => {
    const cred: ChatGPTCredential = { clientId: 'c', accessToken: 'a', refreshToken: 'r', expiresAt: 0, scope: SCOPE }
    const fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    const source = new ChatGPTTokenSource(() => cred, async () => {}, fetchImpl as unknown as typeof fetch)
    await expect(source.accessToken()).rejects.toThrow(/sign in again/)
  })
})

describe('CredentialStore', () => {
  const cipher = (available: boolean): Cipher => ({
    available: () => available,
    encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'),
    decrypt: (s) => Buffer.from(s, 'base64').toString().replace(/^enc:/, '')
  })

  it('encrypts secrets at rest with owner-only permissions', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'blockout-cred-')), 'agent-credentials.json')
    const store = new CredentialStore(file, cipher(true))
    await store.load()
    await store.setKey('anthropic', '  sk-ant-secret-1234 ')
    await store.setChatGPT({ clientId: 'c', accessToken: 'tok', refreshToken: 'ref', expiresAt: 1, scope: 's' })
    await store.setPrefs({ provider: 'gemini', models: { gemini: 'g-1' } })
    await store.setPrefs({ models: { openai: 'o-1' } })

    const raw = readFileSync(file, 'utf-8')
    expect(raw).not.toContain('sk-ant-secret')
    expect(raw).not.toContain('"tok"')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)

    const again = new CredentialStore(file, cipher(true))
    await again.load()
    expect(again.getKey('anthropic')).toBe('sk-ant-secret-1234')
    expect(again.getChatGPT()?.refreshToken).toBe('ref')
    expect(again.prefs).toEqual({ provider: 'gemini', models: { gemini: 'g-1', openai: 'o-1' } })
    await again.setKey('anthropic', '')
    expect(again.getKey('anthropic')).toBeUndefined()
    expect(keyHint('sk-ant-secret-1234')).toBe('••••1234')
  })

  it('re-seals plain-text secrets once encryption becomes available', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'blockout-cred-')), 'agent-credentials.json')
    const plain = new CredentialStore(file, cipher(false))
    await plain.load()
    await plain.setKey('openrouter', 'or-key-9999')
    expect(readFileSync(file, 'utf-8')).toContain('or-key-9999')

    const sealed = new CredentialStore(file, cipher(true))
    await sealed.load()
    expect(sealed.getKey('openrouter')).toBe('or-key-9999')
    await sealed.setKey('gemini', 'gm-key')
    const raw = readFileSync(file, 'utf-8')
    expect(raw).not.toContain('or-key-9999')
    expect(sealed.getKey('openrouter')).toBe('or-key-9999')
    expect(sealed.getKey('gemini')).toBe('gm-key')
  })
})
