/** A `!` command: run by ClaudeCord in the chat's folder, without Claude. */
export type ShellRun = {
  id: string
  sessionPk: number
  command: string
  output: string
  startedAt: number
  state: 'running' | 'done' | 'stopped'
  /** null while running, or when it was stopped or never started. */
  exitCode: number | null
}

export type FolderContents = {
  /** .claude/settings.json or settings.local.json */
  settings: boolean
  /** Hook events its settings run commands on. */
  hooks: string[]
  /** Servers in its .mcp.json. */
  mcpServers: string[]
  /** CLAUDE.md */
  instructions: boolean
  /** .claude/skills, commands or agents */
  extensions: boolean
}

export type FolderTrust = { trusted: boolean; contents: FolderContents }
