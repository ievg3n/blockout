/**
 * Connections → ChatGPT remote connector, end to end without a tunnel
 * (BLOCKOUT_REMOTE_NO_TUNNEL=1): start it from the UI, drive the live app
 * over MCP Streamable HTTP at the shown URL, see the call in "Recent
 * calls", and confirm Stop and New link both kill old URLs.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let app: ElectronApplication
let page: Page

const rpc = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body)
  })

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      BLOCKOUT_REMOTE_NO_TUNNEL: '1',
      BLOCKOUT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'blockout-remote-config-')),
      BLOCKOUT_SMOKE_DIR: mkdtempSync(join(tmpdir(), 'blockout-remote-'))
    }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible()
  await page.getByRole('tab', { name: '✦ Agent' }).click()
  await page.getByRole('button', { name: '⚙ Connections' }).click()
})

test.afterAll(async () => {
  await app?.close()
})

test('the Claude Desktop extension is ready to install', async () => {
  await expect(page.getByRole('button', { name: 'Install in Claude Desktop' })).toBeEnabled()
  await page.getByRole('button', { name: /Claude Code \/ manual setup/ }).click()
  await expect(page.locator('.connect-snippet').first()).toContainText('claude mcp add blockout')
  await expect(page.locator('.connect-snippet').nth(1)).toContainText('blockout-mcp.mjs')
})

test('remote access serves MCP to the live scene and shows activity', async () => {
  await page.getByRole('button', { name: 'Start remote access' }).click()
  const urlBox = page.getByTestId('remote-url')
  await expect(urlBox).toContainText('/mcp/', { timeout: 15_000 })
  await expect(page.locator('.titlebar .remote-dot')).toBeVisible()
  const url = (await urlBox.textContent())!.trim()

  const init = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  expect(init.status).toBe(200)
  const list = (await (await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
    result: { tools: { name: string }[] }
  }
  expect(list.result.tools.map((t) => t.name)).not.toContain('import_scan')

  const call = await rpc(url, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'add_entity', arguments: { assetId: 'person.man', x: 2, z: -1, label: 'REMOTE' } }
  })
  expect(await call.json()).toMatchObject({ result: { isError: false } })
  const labels = await page.evaluate(() =>
    (window as any).__blockout.store
      .getState()
      .scene()
      .entities.map((e: any) => e.label?.text)
  )
  expect(labels).toContain('REMOTE')
  await expect(page.locator('.remote-activity li').first()).toContainText('add_entity')

  // New link: the old URL stops working, the new one works.
  await page.getByRole('button', { name: 'New link' }).click()
  await expect(urlBox).not.toHaveText(url)
  expect((await rpc(url, { jsonrpc: '2.0', id: 4, method: 'ping' })).status).toBe(404)
  const fresh = (await urlBox.textContent())!.trim()
  expect((await rpc(fresh, { jsonrpc: '2.0', id: 5, method: 'ping' })).status).toBe(200)

  // Stop takes the endpoint down entirely.
  await page.getByRole('button', { name: '■ Stop remote access' }).click()
  await expect(page.getByRole('button', { name: 'Start remote access' })).toBeVisible()
  await expect(page.locator('.titlebar .remote-dot')).toHaveCount(0)
  await expect(rpc(fresh, { jsonrpc: '2.0', id: 6, method: 'ping' })).rejects.toThrow()
})
