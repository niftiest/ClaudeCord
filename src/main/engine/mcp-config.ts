import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** The `--mcp-config` file wiring the CLI to ClaudeCord's permission MCP
 *  server (Plan 3 Task 7). The CLI SPAWNS a stdio MCP server as a child
 *  process (per the config's `command`/`args`); that server must relay each
 *  tools/call back to the Electron main process where PermissionBridge parks
 *  it and the UI answers. The config writer + tool-name resolution below are
 *  the pure, tested pieces; the relay shim + its socket to the main process,
 *  and the live confirmation of the CLI↔server handshake + the undocumented
 *  request schema, are the remaining supervised step (see the Task 7 handoff).
 *
 *  Until that lands, new chats run with --dangerously-skip-permissions (the
 *  NewChatDialog toggle stays gated), so this config is NOT referenced by any
 *  live spawn — writing a config that pointed at a non-functional server
 *  would make the CLI hang, which the Plan 2 whole-branch fix explicitly
 *  guards against. */

/** The fully-qualified permission-prompt tool name the CLI resolves against
 *  the `--mcp-config` server named `serverName`. */
export function permissionToolName(serverName: string, tool = 'approve'): string {
  return `mcp__${serverName}__${tool}`
}

/** Build the mcp-config JSON: a single stdio MCP server the CLI will spawn. */
export function buildMcpConfig(serverName: string, command: string, args: string[]): {
  mcpServers: Record<string, { command: string; args: string[] }>
} {
  return { mcpServers: { [serverName]: { command, args } } }
}

/** Write the mcp-config to disk (creating parent dirs). Returns the path. */
export function writeMcpConfig(configPath: string, serverName: string, command: string, args: string[]): string {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(buildMcpConfig(serverName, command, args), null, 2), 'utf8')
  return configPath
}
