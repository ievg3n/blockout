/**
 * "Other AI apps" setup: where the MCP bridge and the Claude Desktop
 * extension live in this build, ready-to-paste client configs, and a
 * one-click hand-off of the .mcpb bundle to Claude Desktop's installer.
 */

import { app, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import type { ConnectInfo } from '../shared/agent'

function paths(): { bundlePath: string; bridgePath: string } {
  // Packaged: resources/mcp (electron-builder extraResources). Source
  // checkout: out/main/index.js → repo root.
  if (app.isPackaged) {
    const dir = join(process.resourcesPath, 'mcp')
    return { bundlePath: join(dir, 'Blockout.mcpb'), bridgePath: join(dir, 'blockout-mcp.mjs') }
  }
  const dir = join(resolve(__dirname, '../..'), 'mcp')
  return { bundlePath: join(dir, 'dist', 'Blockout.mcpb'), bridgePath: join(dir, 'blockout-mcp.mjs') }
}

export function connectInfo(): ConnectInfo {
  const { bundlePath, bridgePath } = paths()
  // A packaged app runs the bridge with its own runtime (Electron as Node),
  // so the user needs no separate Node install.
  const server = app.isPackaged
    ? { command: process.execPath, args: [bridgePath], env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: 'node', args: [bridgePath] }
  return {
    packaged: app.isPackaged,
    bundlePath,
    bundleExists: existsSync(bundlePath),
    bridgePath,
    desktopConfig: JSON.stringify({ mcpServers: { blockout: server } }, null, 2),
    claudeCodeCommand: app.isPackaged
      ? `claude mcp add blockout -e ELECTRON_RUN_AS_NODE=1 -- "${process.execPath}" "${bridgePath}"`
      : `claude mcp add blockout -- node "${bridgePath}"`
  }
}

export function registerConnectIpc(): void {
  ipcMain.handle('connect:info', () => connectInfo())

  ipcMain.handle('connect:installClaudeDesktop', async () => {
    const { bundlePath } = paths()
    if (!existsSync(bundlePath)) {
      return { ok: false, error: 'The Claude Desktop extension is missing from this build — run `npm run build:mcpb`.' }
    }
    const error = await shell.openPath(bundlePath)
    return error
      ? { ok: false, error: `Could not open the extension (${error}). Is Claude Desktop installed?` }
      : { ok: true }
  })

  ipcMain.handle('connect:revealClaudeDesktop', () => {
    shell.showItemInFolder(paths().bundlePath)
  })
}
