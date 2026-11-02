import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { permissionToolName, buildMcpConfig, writeMcpConfig } from '../src/main/engine/mcp-config'

describe('mcp-config', () => {
  it('resolves the fully-qualified permission tool name', () => {
    expect(permissionToolName('claudecord')).toBe('mcp__claudecord__approve')
    expect(permissionToolName('claudecord', 'ask')).toBe('mcp__claudecord__ask')
  })

  it('builds a single-stdio-server config', () => {
    expect(buildMcpConfig('claudecord', 'node', ['shim.js'])).toEqual({
      mcpServers: { claudecord: { command: 'node', args: ['shim.js'] } }
    })
  })

  it('writes the config to disk and round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'))
    try {
      const p = join(dir, 'sub', 'permission-mcp-config.json')
      const out = writeMcpConfig(p, 'claudecord', 'node', ['shim.js', '--port', '5000'])
      expect(out).toBe(p)
      const parsed = JSON.parse(readFileSync(p, 'utf8'))
      expect(parsed.mcpServers.claudecord.args).toEqual(['shim.js', '--port', '5000'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
