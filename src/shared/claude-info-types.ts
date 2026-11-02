/** What a running Claude Code says it has available for a folder. Electron-free:
 *  shared by the main process and the renderer. */

export type CommandSource = 'project' | 'user' | 'plugin' | 'synced' | 'mcp' | 'builtin'

export type ClaudeCommand = {
  /** Without the leading slash, e.g. "compact" or "superpowers:brainstorming". */
  name: string
  description: string
  /** e.g. "<optional custom summarization instructions>"; '' when it takes none. */
  argumentHint: string
  /** Other names that run it, e.g. "brainstorming". */
  aliases: string[]
  source: CommandSource
  /** The plugin it came from, when source is 'plugin'. */
  plugin: string | null
}

export type ClaudeModel = {
  /** What gets passed to --model. */
  value: string
  label: string
  description: string
  /** The full id it currently means, e.g. "claude-opus-5-5". */
  resolved: string | null
  efforts: string[]
}

export type ClaudeInfo = {
  commands: ClaudeCommand[]
  models: ClaudeModel[]
  version: string | null
  fetchedAt: number
}

export type McpServerStatus = {
  name: string
  /** connected | pending | failed | needs-auth | disabled */
  status: string
  error: string | null
  /** user | project | plugin | claudeai | … */
  source: string
  transport: string | null
  /** The command or URL it runs. */
  detail: string
  tools: string[]
}

export type McpCheckResult = { ok: true; servers: McpServerStatus[] } | { ok: false; error: string }

export type ClaudeInfoResult = { ok: true; info: ClaudeInfo } | { ok: false; error: string }

/** Slash commands that need Claude Code's terminal: tested against 2.1.316
 *  without a terminal (or, for logins and installers, inherently interactive).
 *  Claude's own command list can't answer this alone: it lists a few of these
 *  and leaves out aliases that do work, such as /cost. */
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'add-dir', 'bug', 'chrome', 'color', 'doctor', 'exit', 'export', 'focus', 'help', 'hooks', 'ide',
  'install-github-app', 'login', 'logout', 'memory', 'permissions', 'plugin', 'plugins', 'privacy-settings',
  'quit', 'rc', 'release-notes', 'reload-plugins', 'remote-control', 'resume', 'rewind', 'send-to-project',
  'settings', 'skills', 'status', 'statusline', 'tasks', 'terminal-setup', 'theme', 'todos', 'upgrade', 'vim'
])

/** ClaudeCord runs these itself: Claude would start a new session underneath
 *  the open chat, so instead they open a new chat in the same folder. */
export const CLEAR_COMMANDS: ReadonlySet<string> = new Set(['clear', 'new', 'reset'])
