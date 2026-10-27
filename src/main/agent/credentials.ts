/**
 * Agent credentials and preferences, kept in Blockout's config directory
 * (agent-credentials.json, mode 0600, written atomically). Secrets — API
 * keys and the Sign in with ChatGPT token record — are encrypted with
 * Electron safeStorage (Keychain / DPAPI / libsecret) when available and
 * NEVER leave the main process: the renderer only sees "configured" and a
 * short hint.
 */

import { randomUUID } from 'crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { KeyProviderId, ProviderId } from './types'

export interface Cipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(stored: string): string
}

/** Plain-text fallback when the OS keyring is unavailable (the UI warns). */
export const PLAIN_CIPHER: Cipher = {
  available: () => false,
  encrypt: (s) => s,
  decrypt: (s) => s
}

export interface ChatGPTCredential {
  clientId: string
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
  scope: string
  sub?: string
  email?: string
}

interface StoredFile {
  version: 1
  encrypted: boolean
  hostId?: string
  keys?: Partial<Record<KeyProviderId, string>>
  chatgpt?: string
  prefs?: { provider?: ProviderId; models?: Partial<Record<ProviderId, string>> }
}

export class CredentialStore {
  private data: StoredFile = { version: 1, encrypted: false }
  private loaded = false

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {}

  get encryptionAvailable(): boolean {
    return this.cipher.available()
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf-8')) as StoredFile
      if (parsed && parsed.version === 1) this.data = parsed
    } catch {
      // Missing or unreadable: start empty.
    }
    this.loaded = true
  }

  private secret(stored: string | undefined): string | undefined {
    if (!stored) return undefined
    try {
      return this.data.encrypted ? this.cipher.decrypt(stored) : stored
    } catch {
      return undefined // keyring changed (e.g. copied to another machine)
    }
  }

  private seal(plain: string): string {
    return this.data.encrypted ? this.cipher.encrypt(plain) : plain
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, this.file)
  }

  /** Re-seal everything when the cipher's availability differs from the file's. */
  private reseal(): void {
    const encrypted = this.cipher.available()
    if (encrypted === this.data.encrypted) return
    const keys = Object.fromEntries(
      Object.entries(this.data.keys ?? {}).map(([k, v]) => [k, this.secret(v)])
    ) as Partial<Record<KeyProviderId, string | undefined>>
    const chatgpt = this.secret(this.data.chatgpt)
    this.data.encrypted = encrypted
    this.data.keys = {}
    for (const [k, v] of Object.entries(keys)) if (v) this.data.keys[k as KeyProviderId] = this.seal(v)
    this.data.chatgpt = chatgpt ? this.seal(chatgpt) : undefined
  }

  getKey(provider: KeyProviderId): string | undefined {
    return this.secret(this.data.keys?.[provider])
  }

  async setKey(provider: KeyProviderId, key: string | undefined): Promise<void> {
    this.reseal()
    const keys = { ...(this.data.keys ?? {}) }
    const trimmed = key?.trim()
    if (trimmed) keys[provider] = this.seal(trimmed)
    else delete keys[provider]
    this.data.keys = keys
    await this.save()
  }

  getChatGPT(): ChatGPTCredential | undefined {
    const raw = this.secret(this.data.chatgpt)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as ChatGPTCredential
    } catch {
      return undefined
    }
  }

  async setChatGPT(cred: ChatGPTCredential | undefined): Promise<void> {
    this.reseal()
    this.data.chatgpt = cred ? this.seal(JSON.stringify(cred)) : undefined
    await this.save()
  }

  /** Stable per-installation id (Sign in with ChatGPT `ext_agent_host_id`). */
  async hostId(): Promise<string> {
    if (!this.data.hostId) {
      this.data.hostId = `blockout-${randomUUID()}`
      await this.save()
    }
    return this.data.hostId
  }

  get prefs(): NonNullable<StoredFile['prefs']> {
    return this.data.prefs ?? {}
  }

  async setPrefs(prefs: NonNullable<StoredFile['prefs']>): Promise<void> {
    this.data.prefs = { ...this.prefs, ...prefs, models: { ...this.prefs.models, ...prefs.models } }
    await this.save()
  }
}

/** "••••abcd" — enough to recognise a key without revealing it. */
export function keyHint(key: string): string {
  return `••••${key.slice(-4)}`
}
