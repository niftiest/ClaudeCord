import { describe, it, expect } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionRelay } from '../src/main/engine/permission-relay'
import { PermissionBridge } from '../src/main/engine/permission-bridge'
import type { PermissionRequest } from '../src/shared/engine-types'

/** Reads the per-session pipe path out of the mcp-config the relay wrote. */
function pipePathFromConfig(configPath: string): string {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[] }>
  }
  const server = cfg.mcpServers.claudecord!
  expect(server.command).toBe('node')
  return server.args[1]! // [shimPath, pipePath]
}

/** Drives one JSON-RPC line over a socket and resolves with the parsed reply
 *  whose id matches (ignoring any notification-less lines). */
function rpc(sock: Socket, msg: object, expectId: number | string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.id === expectId) { sock.off('data', onData); resolve(parsed); return }
      }
    }
    sock.on('data', onData)
    sock.on('error', reject)
    sock.write(JSON.stringify(msg) + '\n')
  })
}

describe('PermissionRelay', () => {
  it('returns the fully-qualified prompt tool name and a config pointing at the shim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-relay-'))
    const bridge = new PermissionBridge({ toolName: 'approve', timeoutMs: 1000 })
    const relay = new PermissionRelay({ bridge, serverName: 'claudecord', dir })
    try {
      const { mcpConfigArg, permissionPromptTool } = relay.ensure('/f/s1.jsonl')
      expect(permissionPromptTool).toBe('mcp__claudecord__approve')
      const cfg = JSON.parse(readFileSync(mcpConfigArg, 'utf8'))
      expect(cfg.mcpServers.claudecord.command).toBe('node')
      expect(cfg.mcpServers.claudecord.args[0]).toMatch(/permission-mcp-shim\.cjs$/)
    } finally {
      relay.shutdown(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent per session: same config + pipe returned on repeat ensure()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-relay-'))
    const bridge = new PermissionBridge({ toolName: 'approve', timeoutMs: 1000 })
    const relay = new PermissionRelay({ bridge, serverName: 'claudecord', dir })
    try {
      const a = relay.ensure('/f/s1.jsonl')
      const b = relay.ensure('/f/s1.jsonl')
      expect(a).toEqual(b)
      const c = relay.ensure('/f/s2.jsonl')
      expect(c.mcpConfigArg).not.toBe(a.mcpConfigArg) // a different session gets its own
    } finally {
      relay.shutdown(); rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes a full initialize / tools/list / tools/call round-trip through the bridge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-relay-'))
    const bridge = new PermissionBridge({ toolName: 'approve', timeoutMs: 5000 })
    const relay = new PermissionRelay({ bridge, serverName: 'claudecord', dir })

    // Auto-allow every parked request, capturing it so we can assert routing.
    const seen: PermissionRequest[] = []
    bridge.onRequest((req) => {
      seen.push(req)
      bridge.resolve(req.id, { behavior: 'allow', updatedInput: req.input })
    })

    const { mcpConfigArg } = relay.ensure('/f/s1.jsonl')
    const pipePath = pipePathFromConfig(mcpConfigArg)

    const sock = connect(pipePath)
    await new Promise<void>((res, rej) => { sock.once('connect', res); sock.once('error', rej) })

    try {
      const init = await rpc(sock, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, 0)
      expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('claudecord-permission-bridge')

      const list = await rpc(sock, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 1)
      const tools = (list.result as { tools: { name: string }[] }).tools
      expect(tools[0]!.name).toBe('approve') // bare name -- CLI prefixes the server itself

      const call = await rpc(sock, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'echo hi > f.txt' }, tool_use_id: 'toolu_x' } }
      }, 2)
      const content = (call.result as { content: { text: string }[] }).content
      const payload = JSON.parse(content[0]!.text) as { behavior: string; updatedInput: unknown }
      expect(payload.behavior).toBe('allow')
      expect(payload.updatedInput).toEqual({ command: 'echo hi > f.txt' })

      // The parked request was tagged with the session it belongs to (routing).
      expect(seen).toHaveLength(1)
      expect(seen[0]!.sessionKey).toBe('/f/s1.jsonl')
      expect(seen[0]!.tool).toBe('Bash')
      expect(seen[0]!.toolUseId).toBe('toolu_x')
    } finally {
      sock.destroy(); relay.shutdown(); rmSync(dir, { recursive: true, force: true })
    }
  })
})
