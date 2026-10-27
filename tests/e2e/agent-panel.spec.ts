/**
 * Agent panel e2e with the scripted provider (BLOCKOUT_AGENT_FAKE=1): the
 * chat drives real control actions in the live app — an actor lands in the
 * store, tool chips and the screenshot thumbnail render, the work is
 * undoable, Stop interrupts a turn, and Connections never shows a secret.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let app: ElectronApplication
let page: Page

const labels = (): Promise<string[]> =>
  page.evaluate(() => {
    const s = (window as any).__blockout.store.getState()
    return (s.scene()?.entities ?? []).map((e: any) => e.label?.text).filter(Boolean)
  })

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      BLOCKOUT_AGENT_FAKE: '1',
      BLOCKOUT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'blockout-agent-config-')),
      BLOCKOUT_SMOKE_DIR: mkdtempSync(join(tmpdir(), 'blockout-agent-'))
    }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
})

test('the A key and the tab open the agent panel', async () => {
  await page.locator('.viewport-wrap').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('a')
  await expect(page.getByRole('tab', { name: '✦ Agent' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.agent-example')).toHaveCount(3)
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await expect(page.locator('.agent-panel')).toHaveCount(0)
  await page.getByRole('tab', { name: '✦ Agent' }).click()
  await expect(page.locator('.agent-panel')).toBeVisible()
})

test('a message runs tools against the live scene and shows the result', async () => {
  const box = page.getByLabel('Message the agent')
  await box.fill('Put an actor on set')
  await box.press('Enter')

  await expect(page.locator('.agent-msg.user')).toHaveText('Put an actor on set')
  await expect(page.locator('.agent-msg.assistant').last()).toContainText('Done — AGENT1 is on set.', { timeout: 20_000 })
  await expect(page.locator('.agent-tool.ok')).toHaveCount(2)
  await expect(page.locator('.agent-tool code').first()).toHaveText('add_entity')
  await expect(page.locator('.agent-shot')).toBeVisible()
  await expect(page.locator('.agent-thinking').first()).toBeAttached()
  expect(await labels()).toContain('AGENT1')

  // Agent edits are ordinary undo steps (place + label).
  await page.evaluate(() => {
    const s = (window as any).__blockout.store.getState()
    s.undo()
    s.undo()
  })
  expect(await labels()).not.toContain('AGENT1')
})

test('Stop interrupts a running turn', async () => {
  const box = page.getByLabel('Message the agent')
  await box.fill('Another one')
  await box.press('Enter')
  await page.getByRole('button', { name: '■ Stop' }).click()
  await expect(page.locator('.agent-notice', { hasText: 'Stopped.' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Send ↵' })).toBeVisible()
})

test('New chat clears the transcript', async () => {
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.locator('.agent-msg')).toHaveCount(0)
  await expect(page.locator('.agent-example')).toHaveCount(3)
})

test('Connections lists sign-in and key slots without exposing secrets', async () => {
  await page.getByRole('button', { name: '⚙ Connections' }).click()
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  for (const name of ['Claude (Anthropic)', 'OpenAI', 'Google Gemini', 'MiniMax', 'OpenRouter']) {
    await expect(page.getByLabel(`${name} API key`)).toHaveValue('')
  }
  await page.getByRole('button', { name: '⚙ Connections' }).click()
  await expect(page.getByLabel('Message the agent')).toBeVisible()
})
