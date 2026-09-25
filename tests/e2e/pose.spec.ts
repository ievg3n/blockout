/**
 * Pose tool: real-mouse limb drags key poses at the playhead (Shoot), the
 * keys interpolate, Stage drags write the static pose, and the side panels
 * resize by dragging their edges.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, BLOCKOUT_SMOKE_DIR: mkdtempSync(join(tmpdir(), 'blockout-pose-')) }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.getByRole('button', { name: 'New Project' }).click()
  await page.waitForTimeout(500)
})

test.afterAll(async () => {
  await app?.close()
})

/** Screen position of a pose handle on the posed person. */
async function handleAt(id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((handleId) => {
    const sc = (window as any).__blockout_scene
    const v = sc.poseHandleMeshes.get(handleId).position.clone().project(sc.freeCam)
    const r = sc.canvas.getBoundingClientRect()
    return { x: ((v.x + 1) / 2) * r.width + r.left, y: ((1 - v.y) / 2) * r.height + r.top }
  }, id)
}

async function drag(from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(150)
}

test('dragging limbs keys poses that interpolate over time', async () => {
  const id = await page.evaluate(() => {
    const s = (window as any).__blockout.store.getState()
    const id = s.addEntity('person.man', { x: 0, y: 0, z: 0 })
    s.setMode('shoot')
    s.setSelection({ kind: 'entity', entityId: id })
    const sc = (window as any).__blockout_scene
    sc.freeCam.position.set(3, 1.5, -3)
    sc.controls.target.set(0, 1, 0)
    return id as string
  })
  await page.waitForTimeout(300)
  await page.keyboard.press('p')
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => (window as any).__blockout_scene.poseGroup.visible)).toBe(true)

  await drag(await handleAt('handR'), -40, -140)
  await page.evaluate(() => (window as any).__blockout.store.getState().setTime(2))
  await page.waitForTimeout(150)
  await drag(await handleAt('footL'), 30, -80)

  const track = await page.evaluate((eid) => (window as any).__blockout.store.getState().poseTrack(eid), id)
  expect(track.keys.map((k: { time: number }) => k.time)).toEqual([0, 2])
  expect(Object.keys(track.keys[0].joints).some((k: string) => k.startsWith('shoulderR'))).toBe(true)
  expect(Object.keys(track.keys[1].joints).some((k: string) => k.startsWith('hipL'))).toBe(true)

  // Timeline shows a pose lane with both diamonds.
  await expect(page.locator('.pose-key')).toHaveCount(2)

  // Undo removes the second key in one step.
  await page.keyboard.press('Escape') // leave pose mode first (keeps focus off inputs)
  await page.keyboard.press('Meta+z')
  const after = await page.evaluate((eid) => (window as any).__blockout.store.getState().poseTrack(eid), id)
  expect(after.keys.length).toBe(1)
})

test('stage-mode drags write the static pose, not keys', async () => {
  const id = await page.evaluate(() => {
    const s = (window as any).__blockout.store.getState()
    s.setMode('stage')
    const id = s.addEntity('person.woman', { x: 2, y: 0, z: 0 })
    s.setSelection({ kind: 'entity', entityId: id })
    s.setPoseMode(true)
    const sc = (window as any).__blockout_scene
    sc.freeCam.position.set(5, 1.5, -3)
    sc.controls.target.set(2, 1, 0)
    return id as string
  })
  await page.waitForTimeout(300)
  await drag(await handleAt('handL'), 60, -120)
  const result = await page.evaluate((eid) => {
    const s = (window as any).__blockout.store.getState()
    const e = s.scene().entities.find((x: { id: string }) => x.id === eid)
    return { params: e.params ?? {}, track: s.poseTrack(eid) }
  }, id)
  expect(Object.keys(result.params).some((k) => k.startsWith('joint_shoulderL'))).toBe(true)
  expect(result.track).toBeNull()
})

test('side panels resize by dragging their edges', async () => {
  const before = await page.evaluate(() => (window as any).__blockout.store.getState().panelWidths)
  const box = (await page.locator('.panel-resizer.right').boundingBox())!
  await page.mouse.move(box.x + 3, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x - 100, box.y + 200, { steps: 5 })
  await page.mouse.up()
  const after = await page.evaluate(() => (window as any).__blockout.store.getState().panelWidths)
  expect(after.right).toBeGreaterThan(before.right + 80)
  const inspectorWidth = await page.locator('.panel.right').evaluate((el) => el.getBoundingClientRect().width)
  expect(Math.abs(inspectorWidth - after.right)).toBeLessThan(2)
  await page.locator('.panel-resizer.right').dblclick()
  const reset = await page.evaluate(() => (window as any).__blockout.store.getState().panelWidths)
  expect(reset.right).toBe(264)
  // Widths persist per machine — leave the default layout behind.
  await page.locator('.panel-resizer.left').dblclick()
})
