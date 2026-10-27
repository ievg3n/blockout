#!/usr/bin/env node
// Modified for cross-platform Windows support and AI connections in 2026; see MODIFICATIONS.md.
/**
 * Blockout MCP server — zero-dependency Node >=18 stdio bridge.
 *
 * Speaks the MCP stdio transport: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout (NOT Content-Length framed). Each tools/call is forwarded to
 * the running app's HTTP control server, discovered via
 * Blockout's platform config directory (random localhost port + bearer token).
 *
 * Uses only node built-ins + global fetch — run directly with `node`. The
 * tool catalog and JSON-RPC handling live in tools.mjs / protocol.mjs, which
 * must ship alongside this file.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { TOOLS } from './tools.mjs'
import { createMcpHandler } from './protocol.mjs'

function configDir() {
  if (process.env.BLOCKOUT_CONFIG_DIR?.trim()) return process.env.BLOCKOUT_CONFIG_DIR.trim()
  if (process.platform === 'win32') {
    const namespace = process.env.BLOCKOUT_CONFIG_NAMESPACE || 'blockout'
    const segments = namespace.split(/[\\/]+/).filter((part) => part && part !== '.' && part !== '..')
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      ...(segments.length > 0 ? segments : ['blockout'])
    )
  }
  return join(homedir(), '.config', 'blockout')
}

const DISCOVERY_FILES = process.env.BLOCKOUT_CONFIG_DIR?.trim()
  ? [join(configDir(), 'control.json')]
  : [...new Set([
      join(configDir(), 'control.json'),
      // Legacy descriptor location; descriptors without protocolVersion remain valid.
      join(homedir(), '.config', 'blockout', 'control.json')
    ])]

/* ------------------------------ control call ---------------------------- */

const NOT_RUNNING = "Blockout isn't running — launch the app first."

async function callControl(action, params) {
  let config
  for (const file of DISCOVERY_FILES) {
    try {
      const candidate = JSON.parse(await readFile(file, 'utf-8'))
      if (Number.isInteger(candidate?.port) && typeof candidate?.token === 'string') {
        config = candidate
        break
      }
    } catch {
      // Try the next current/legacy discovery location.
    }
  }
  if (!config || (config.protocolVersion !== undefined && config.protocolVersion !== 1) ||
    (config.app !== undefined && config.app !== 'blockout')) {
    return { error: NOT_RUNNING }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify({ action, params: params ?? {} })
    })
    return { response: await res.json() }
  } catch {
    return { error: NOT_RUNNING }
  }
}

/* ---------------------------- JSON-RPC plumbing ------------------------- */

const handle = createMcpHandler({ tools: TOOLS, callControl })

async function respond(msg) {
  const reply = await handle(msg)
  if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
}

/* ------------------------------- stdin loop ----------------------------- */

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore non-JSON lines
    }
    void respond(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
