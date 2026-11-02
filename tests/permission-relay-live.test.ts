import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionRelay } from '../src/main/engine/permission-relay'
import { PermissionBridge } from '../src/main/engine/permission-bridge'
import type { PermissionRequest } from '../src/shared/engine-types'

/**
 * LIVE end-to-end check of the permission relay against a real `claude` binary.
 * Gated behind RUN_LIVE_CLAUDE=1 so the normal suite never spawns claude / hits
 * the network. Run manually:
 *
 *   RUN_LIVE_CLAUDE=1 npx vitest run tests/permission-relay-live.test.ts
 *
 * Proves the full chain: claude -p (skip-perms OFF) -> spawns the relay shim ->
 * pipe -> in-process McpStdioServer -> PermissionBridge -> auto-allow -> the
 * gated tool actually executes (a file gets written).
 */
const LIVE = process.env.RUN_LIVE_CLAUDE === '1'

describe.skipIf(!LIVE)('PermissionRelay (LIVE claude)', () => {
  it('routes a real tool-permission request through the relay and approves it', async () => {
    const relayDir = mkdtempSync(join(tmpdir(), 'cc-relay-live-'))
    const workDir = mkdtempSync(join(tmpdir(), 'cc-relay-work-'))
    const bridge = new PermissionBridge({ toolName: 'approve', timeoutMs: 60_000 })
    const relay = new PermissionRelay({ bridge, serverName: 'claudecord', dir: relayDir })

    const seen: PermissionRequest[] = []
    bridge.onRequest((req) => {
      seen.push(req)
      bridge.resolve(req.id, { behavior: 'allow', updatedInput: req.input })
    })

    const { mcpConfigArg, permissionPromptTool } = relay.ensure('/live/session.jsonl')
    const probe = join(workDir, 'relay-probe.txt')

    try {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn('claude', [
          '-p', `Use the Bash tool to run exactly: echo relaytest > relay-probe.txt`,
          '--permission-mode', 'default',
          '--permission-prompt-tool', permissionPromptTool,
          '--mcp-config', mcpConfigArg
        ], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
        let stderr = ''
        child.stderr.on('data', (c) => { stderr += c.toString() })
        child.on('error', reject)
        child.on('exit', (c) => { if (stderr) console.log('[live stderr]', stderr.slice(-500)); resolve(c ?? -1) })
      })

      expect(code).toBe(0)
      expect(seen.length).toBeGreaterThanOrEqual(1)        // the CLI asked our relay
      expect(seen.some((r) => r.tool === 'Bash')).toBe(true)
      expect(existsSync(probe)).toBe(true)                  // the approved tool actually ran
      expect(readFileSync(probe, 'utf8').trim()).toBe('relaytest')
    } finally {
      relay.shutdown()
      rmSync(relayDir, { recursive: true, force: true })
      rmSync(workDir, { recursive: true, force: true })
    }
  }, 120_000)
})
