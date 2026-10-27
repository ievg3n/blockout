/**
 * Agent panel backend: owns credentials, the active provider/model, and the
 * single live AgentSession, and exposes them to the renderer over `agent:*`
 * IPC. Tool calls go through the same control invoker as the MCP bridge.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { ipcMain, nativeImage, safeStorage, shell, type BrowserWindow } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { resolveConfigPath } from '../../shared/config-paths'
import type { ControlInvoke } from '../control'
import { ChatGPTTokenSource, revokeChatGPT, signInWithChatGPT } from './chatgpt-auth'
import { CredentialStore, keyHint, PLAIN_CIPHER, type Cipher } from './credentials'
import { AnthropicConversation, ANTHROPIC_DEFAULT_MODEL, listAnthropicModels } from './providers/anthropic'
import { FakeConversation } from './providers/fake'
import {
  ChatConversation,
  COMPAT_BASE_URLS,
  listOpenAIModels,
  OPENROUTER_HEADERS,
  ResponsesConversation,
  ResponseStreamError
} from './providers/openai'
import { AgentSession } from './session'
import {
  PROVIDER_IDS,
  type AgentConfig,
  type AgentEvent,
  type KeyProviderId,
  type ProviderConversation,
  type ProviderId,
  type ProviderStatus,
  type ToolOutcome
} from './types'

const MAX_IMAGE_WIDTH = 1280

function electronCipher(): Cipher {
  const weakLinux =
    process.platform === 'linux' &&
    typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  if (weakLinux) return PLAIN_CIPHER
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
  }
}

/** Screenshots go to the model as ≤1280px JPEG: same framing, a fraction of the tokens. */
function prepareImage(pngBase64: string): NonNullable<ToolOutcome['image']> {
  const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'))
  if (img.isEmpty()) return { base64: pngBase64, mediaType: 'image/png' }
  const scaled = img.getSize().width > MAX_IMAGE_WIDTH ? img.resize({ width: MAX_IMAGE_WIDTH, quality: 'good' }) : img
  return { base64: scaled.toJPEG(82).toString('base64'), mediaType: 'image/jpeg' }
}

const isKeyProvider = (p: ProviderId): p is KeyProviderId => p !== 'chatgpt'
const isProvider = (p: unknown): p is ProviderId => typeof p === 'string' && (PROVIDER_IDS as string[]).includes(p)

/** Key from the analyze feature's legacy key file, so one saved Claude key serves both. */
async function legacyAnthropicKey(): Promise<string | undefined> {
  try {
    return (await readFile(resolveConfigPath('anthropic-api-key'), 'utf-8')).trim() || undefined
  } catch {
    return undefined
  }
}

function hasAntProfile(): boolean {
  const dir = join(homedir(), '.config', 'anthropic')
  try {
    return existsSync(dir) && readdirSync(dir).length > 0
  } catch {
    return false
  }
}

const AUTH_HELP: Record<ProviderId, string> = {
  anthropic: 'Claude rejected the API key — check it in Connections.',
  openai: 'OpenAI rejected the API key — check it in Connections.',
  chatgpt: 'ChatGPT sign-in is no longer valid — sign in again in Connections.',
  gemini: 'Gemini rejected the API key — check it in Connections.',
  minimax: 'MiniMax rejected the API key — check it in Connections.',
  openrouter: 'OpenRouter rejected the API key — check it in Connections.'
}

function friendlyError(provider: ProviderId, e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError || e instanceof OpenAI.AuthenticationError) {
    return new Error(AUTH_HELP[provider])
  }
  if (e instanceof Anthropic.RateLimitError || e instanceof OpenAI.RateLimitError) {
    return new Error('The provider is rate-limiting requests — wait a moment and try again.')
  }
  if (e instanceof ResponseStreamError && e.code?.startsWith('subscription_sharing_usage')) {
    return new Error('Your ChatGPT plan usage for Blockout is used up or unavailable right now. Try later or switch provider.')
  }
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) {
    return new Error(`${provider} API error: ${e.message}`)
  }
  if (e instanceof Error && /Could not resolve authentication|apiKey|api key/i.test(e.message)) {
    return new Error('No credential for this provider — add one in Connections.')
  }
  return e instanceof Error ? e : new Error(String(e))
}

/** Wrap a conversation so provider errors reach the panel as readable messages. */
function withFriendlyErrors(provider: ProviderId, conv: ProviderConversation): ProviderConversation {
  return {
    addUserText: (t) => conv.addUserText(t),
    addToolResults: (r) => conv.addToolResults(r),
    step: async (cb) => {
      try {
        return await conv.step(cb)
      } catch (e) {
        if (cb.signal.aborted) throw e
        throw friendlyError(provider, e)
      }
    }
  }
}

export function registerAgentIpc(opts: { invoke: ControlInvoke; getWindow: () => BrowserWindow | null }): void {
  const store = new CredentialStore(resolveConfigPath('agent-credentials.json'), electronCipher())
  const tokens = new ChatGPTTokenSource(
    () => store.getChatGPT(),
    (c) => store.setChatGPT(c)
  )
  const fake = process.env.BLOCKOUT_AGENT_FAKE === '1'
  let session: AgentSession | null = null
  let signIn: AbortController | null = null

  const emit = (event: AgentEvent): void => opts.getWindow()?.webContents.send('agent:event', event)

  const dropSession = (): void => {
    session?.stop()
    session = null
  }

  const currentProvider = (): ProviderId => store.prefs.provider ?? 'anthropic'
  const modelFor = (p: ProviderId): string | undefined =>
    store.prefs.models?.[p] ?? (p === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : undefined)

  async function status(p: ProviderId): Promise<ProviderStatus> {
    // Test mode: key providers look connected; sign-in stays real so its UI is testable.
    if (fake && p !== 'chatgpt') return { id: p, configured: true, hint: 'test' }
    if (p === 'chatgpt') {
      const cred = store.getChatGPT()
      return { id: p, configured: !!cred, hint: cred?.email, source: cred ? 'saved' : undefined }
    }
    const saved = store.getKey(p)
    if (saved) return { id: p, configured: true, hint: keyHint(saved), source: 'saved' }
    if (p === 'anthropic') {
      if (process.env.ANTHROPIC_API_KEY) return { id: p, configured: true, source: 'env' }
      const legacy = await legacyAnthropicKey()
      if (legacy) return { id: p, configured: true, hint: keyHint(legacy), source: 'saved' }
      if (hasAntProfile()) return { id: p, configured: true, source: 'profile' }
    }
    if (p === 'openai' && process.env.OPENAI_API_KEY) return { id: p, configured: true, source: 'env' }
    return { id: p, configured: false }
  }

  async function config(): Promise<AgentConfig> {
    await store.load()
    return {
      provider: currentProvider(),
      models: Object.fromEntries(PROVIDER_IDS.map((p) => [p, modelFor(p)])) as AgentConfig['models'],
      providers: await Promise.all(PROVIDER_IDS.map(status)),
      encryptionAvailable: store.encryptionAvailable
    }
  }

  async function openAIClient(p: Exclude<ProviderId, 'anthropic' | 'chatgpt'>): Promise<OpenAI> {
    const apiKey = store.getKey(p) ?? (p === 'openai' ? process.env.OPENAI_API_KEY : undefined)
    if (!apiKey) throw new Error('No API key for this provider — add one in Connections.')
    if (p === 'openai') return new OpenAI({ apiKey })
    return new OpenAI({
      apiKey,
      baseURL: COMPAT_BASE_URLS[p],
      ...(p === 'openrouter' ? { defaultHeaders: OPENROUTER_HEADERS } : {})
    })
  }

  const chatgptClient = async (): Promise<OpenAI> => new OpenAI({ apiKey: await tokens.accessToken(), maxRetries: 0 })

  async function anthropicClient(): Promise<Anthropic> {
    // undefined lets the SDK resolve ANTHROPIC_API_KEY or an `ant auth login` profile.
    return new Anthropic({ apiKey: store.getKey('anthropic') ?? (await legacyAnthropicKey()) })
  }

  async function createConversation(p: ProviderId): Promise<ProviderConversation> {
    if (fake) return new FakeConversation()
    const model = modelFor(p)
    if (!model) throw new Error('Pick a model for this provider in the Agent panel header.')
    let conv: ProviderConversation
    if (p === 'anthropic') conv = new AnthropicConversation(await anthropicClient(), model)
    else if (p === 'chatgpt') conv = new ResponsesConversation(chatgptClient, model)
    else if (p === 'openai') {
      const client = await openAIClient(p)
      conv = new ResponsesConversation(async () => client, model)
    } else conv = new ChatConversation(await openAIClient(p), model)
    return withFriendlyErrors(p, conv)
  }

  ipcMain.handle('agent:getConfig', () => config())

  ipcMain.handle('agent:setProvider', async (_e, provider: unknown, model?: unknown) => {
    await store.load()
    if (!isProvider(provider)) throw new Error('Unknown provider')
    const models = typeof model === 'string' && model.trim() ? { [provider]: model.trim() } : undefined
    if (provider !== currentProvider() || (models && models[provider] !== modelFor(provider))) dropSession()
    await store.setPrefs({ provider, ...(models ? { models } : {}) })
    return config()
  })

  ipcMain.handle('agent:setKey', async (_e, provider: unknown, key: unknown) => {
    await store.load()
    if (!isProvider(provider) || !isKeyProvider(provider)) throw new Error('Unknown provider')
    await store.setKey(provider, typeof key === 'string' ? key : undefined)
    if (provider === currentProvider()) dropSession()
    return config()
  })

  ipcMain.handle('agent:listModels', async (_e, provider: unknown) => {
    await store.load()
    if (!isProvider(provider)) throw new Error('Unknown provider')
    if (fake) return ['fake-model']
    try {
      if (provider === 'anthropic') return await listAnthropicModels(await anthropicClient())
      if (provider === 'chatgpt') return await listOpenAIModels(await chatgptClient(), 'chatgpt')
      return await listOpenAIModels(await openAIClient(provider), provider)
    } catch (e) {
      throw friendlyError(provider, e)
    }
  })

  ipcMain.handle('agent:send', async (_e, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Empty message' }
    await store.load()
    if (session?.busy) return { ok: false, error: 'The agent is still working.' }
    try {
      if (!session) {
        session = new AgentSession(await createConversation(currentProvider()), {
          invoke: opts.invoke,
          emit,
          prepareImage
        })
      }
    } catch (e) {
      return { ok: false, error: friendlyError(currentProvider(), e).message }
    }
    void session.send(text.trim())
    return { ok: true }
  })

  ipcMain.handle('agent:stop', () => session?.stop())
  ipcMain.handle('agent:reset', () => dropSession())

  ipcMain.handle('agent:chatgptSignIn', async () => {
    await store.load()
    signIn?.abort()
    const controller = new AbortController()
    signIn = controller
    try {
      const cred = await signInWithChatGPT({
        hostId: await store.hostId(),
        previous: store.getChatGPT(),
        openBrowser: (url) => shell.openExternal(url),
        signal: controller.signal
      })
      await store.setChatGPT(cred)
      await store.setPrefs({ provider: 'chatgpt' })
      dropSession()
      return { ok: true, config: await config() }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), config: await config() }
    } finally {
      if (signIn === controller) signIn = null
    }
  })

  ipcMain.handle('agent:chatgptCancel', () => signIn?.abort())

  ipcMain.handle('agent:chatgptSignOut', async () => {
    await store.load()
    const cred = store.getChatGPT()
    if (currentProvider() === 'chatgpt') dropSession()
    const revoked = cred ? await revokeChatGPT(cred) : true
    await store.setChatGPT(undefined)
    return { revoked, config: await config() }
  })
}
