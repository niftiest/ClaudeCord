import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FolderContents } from '../../shared/shell-run-types'

/** Whether a new chat may start in a folder without asking. ClaudeCord's chats run
 *  `claude -p`, which skips Claude Code's own "do you trust this folder?" prompt,
 *  so a folder's settings, hooks and MCP servers would otherwise apply unannounced.
 *
 *  The answer is kept in ClaudeCord's settings, not ~/.claude.json: Claude Code
 *  rewrites that file constantly, so editing it from here could lose either side's
 *  change. A terminal may therefore still ask for itself. */

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** `cwd` and every folder above it, normalized. */
function withAncestors(cwd: string): string[] {
  const out: string[] = []
  let current = cwd
  for (;;) {
    out.push(normalize(current))
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

/** Trusted in Claude Code's own records, directly or through a parent folder. */
export function claudeTrusts(cwd: string, claudeJson: string | null): boolean {
  if (claudeJson === null) return false
  let root: unknown
  try { root = JSON.parse(claudeJson) } catch { return false }
  const projects = (root as { projects?: unknown } | null)?.projects
  if (typeof projects !== 'object' || projects === null) return false
  const trusted = new Set(Object.entries(projects)
    .filter(([, v]) => (v as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted === true)
    .map(([k]) => normalize(k)))
  return withAncestors(cwd).some(p => trusted.has(p))
}

/** ClaudeCord's own list: the folder or a parent the user already said yes to. */
export function listTrusts(cwd: string, trustedFolders: string[]): boolean {
  const trusted = new Set(trustedFolders.map(normalize))
  return withAncestors(cwd).some(p => trusted.has(p))
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** What in this folder would take effect, for the prompt to name. */
export function folderContents(cwd: string): FolderContents {
  const claudeDir = join(cwd, '.claude')
  const settingsFiles = [join(claudeDir, 'settings.json'), join(claudeDir, 'settings.local.json')]
  const hooks = new Set<string>()
  for (const file of settingsFiles) {
    const h = readJson(file)?.hooks
    if (typeof h === 'object' && h !== null) for (const event of Object.keys(h)) hooks.add(event)
  }
  const servers = readJson(join(cwd, '.mcp.json'))?.mcpServers
  return {
    settings: settingsFiles.some(existsSync),
    hooks: [...hooks].sort(),
    mcpServers: typeof servers === 'object' && servers !== null ? Object.keys(servers).sort() : [],
    instructions: existsSync(join(cwd, 'CLAUDE.md')),
    extensions: ['skills', 'commands', 'agents'].some(d => existsSync(join(claudeDir, d)))
  }
}
