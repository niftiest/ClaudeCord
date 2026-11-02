import { createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { McpStdioServer, type PermissionBridge } from './permission-bridge'
import { writeMcpConfig, permissionToolName } from './mcp-config'

/** What the coordinator needs from the relay: given a session, ensure its
 *  permission MCP server is listening and return the two spawn args that wire
 *  the CLI to it. Kept as an interface so the coordinator stays free of
 *  net/fs and can be tested with a trivial fake. */
export interface PermissionRelayLike {
  ensure(sessionKey: string): { mcpConfigArg: string; permissionPromptTool: string }
}

/** The bundled stdio shim the CLI actually spawns (via `--mcp-config`). It is a
 *  DUMB byte relay: it connects to the per-session named pipe this process
 *  listens on and tunnels stdin<->pipe<->stdout. All JSON-RPC / MCP logic lives
 *  in the main process (McpStdioServer over the pipe socket), so the shim never
 *  needs updating when the protocol changes. Embedded as a string and written
 *  to disk at runtime so it ships without any electron-vite asset-copy config
 *  (works identically in `dev` and a packaged build). No deps beyond node core. */
const SHIM_SOURCE = `'use strict'
// ClaudeCord permission MCP relay shim (generated). Tunnels the CLI's stdio
// MCP connection to the ClaudeCord main process over a local pipe/socket.
const net = require('net')
const pipePath = process.argv[2]
if (!pipePath) { process.stderr.write('permission-relay shim: missing pipe path\\n'); process.exit(1) }
const sock = net.connect(pipePath)
sock.on('error', (e) => { process.stderr.write('permission-relay shim: ' + e.message + '\\n'); process.exit(1) })
sock.on('connect', () => {
  process.stdin.pipe(sock)
  sock.pipe(process.stdout)
})
sock.on('close', () => process.exit(0))
process.stdin.on('end', () => { try { sock.end() } catch (_) {} })
`

/** Bridges the CLI-spawned stdio MCP server to ClaudeCord's in-process
 *  PermissionBridge. The CLI runs its permission server as a CHILD PROCESS, but
 *  our parking coordinator + UI live in the Electron main process; this class
 *  is the connection between them.
 *
 *  Per session (keyed by sessionKey): a named-pipe listener whose every
 *  incoming connection is handed to the existing, tested McpStdioServer (bound
 *  to that sessionKey, so parked requests route back to the right chat), and a
 *  written `--mcp-config` pointing the shim at that pipe. The pipe NAME carries
 *  the routing -- no handshake -- so sessionKey is fixed at listener creation.
 *
 *  Only referenced when a chat runs with skip-permissions OFF; while every chat
 *  runs with --dangerously-skip-permissions the relay is created but never
 *  connected to. */
export class PermissionRelay implements PermissionRelayLike {
  private readonly entries = new Map<string, { server: Server; configPath: string; promptTool: string }>()
  private counter = 0
  private shimPath: string | null = null
  private stopped = false

  constructor(private readonly opts: {
    bridge: PermissionBridge
    /** MCP server name; the CLI resolves the prompt tool as
     *  `mcp__<serverName>__<bridge.toolName>`. */
    serverName: string
    /** Writable dir (under userData) for the shim + per-session config files. */
    dir: string
  }) {}

  private ensureShim(): string {
    if (this.shimPath !== null) return this.shimPath
    mkdirSync(this.opts.dir, { recursive: true })
    const p = join(this.opts.dir, 'permission-mcp-shim.cjs')
    writeFileSync(p, SHIM_SOURCE, 'utf8')
    this.shimPath = p
    return p
  }

  private pipePathFor(id: number): string {
    // Windows named pipes live in the \\.\pipe\ namespace and auto-clean when
    // the server closes; elsewhere use a unix-domain socket file in `dir`.
    if (process.platform === 'win32') return `\\\\.\\pipe\\claudecord-perm-${process.pid}-${id}`
    return join(this.opts.dir, `perm-${process.pid}-${id}.sock`)
  }

  ensure(sessionKey: string): { mcpConfigArg: string; permissionPromptTool: string } {
    const existing = this.entries.get(sessionKey)
    if (existing !== undefined) return { mcpConfigArg: existing.configPath, permissionPromptTool: existing.promptTool }

    const shim = this.ensureShim()
    const id = ++this.counter
    const pipePath = this.pipePathFor(id)
    const promptTool = permissionToolName(this.opts.serverName, this.opts.bridge.toolName)

    const server = createServer((socket: Socket) => {
      // Each CLI (re)spawn opens a fresh connection; give it its own server
      // instance bound to this session. The shared PermissionBridge does the
      // actual parking + UI fan-out.
      new McpStdioServer(this.opts.bridge, sessionKey, { input: socket, output: socket }).start()
      socket.on('error', () => { /* CLI end went away mid-call; nothing to do */ })
    })
    server.on('error', (err) => console.error('[permission-relay] pipe server error', err))
    if (process.platform !== 'win32') { try { rmSync(pipePath, { force: true }) } catch { /* no stale socket */ } }
    server.listen(pipePath)

    const configPath = join(this.opts.dir, `perm-config-${id}.json`)
    writeMcpConfig(configPath, this.opts.serverName, 'node', [shim, pipePath])

    this.entries.set(sessionKey, { server, configPath, promptTool })
    return { mcpConfigArg: configPath, permissionPromptTool: promptTool }
  }

  /** Close every listener (app quit). Idempotent. */
  shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    for (const { server } of this.entries.values()) { try { server.close() } catch { /* already closed */ } }
    this.entries.clear()
  }
}
