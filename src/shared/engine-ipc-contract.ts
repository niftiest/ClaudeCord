import type { GithubRepoList, GithubStatus, PrepareRepoOutcome } from './github-types'
import type { FolderTrust, ShellRun } from './shell-run-types'
import type { MemoryFile, MemoryFileContent, MemorySaveResult } from './project-memory-types'
import type { ProjectSettings, ContextUsage } from './project-options'
import type { ClaudeInfoResult, McpCheckResult, McpServerStatus } from './claude-info-types'
import type { LiveEvent, PermissionRequest, PermissionDecision, EngineSnapshot, ExternalLock, RemoteSession, TurnInfo, BackgroundTask } from './engine-types'
export type { EngineSnapshot, ExternalLock, RemoteSession } from './engine-types'
// Type-only import: StreamedRow's home module reads real files (node:fs), but
// importing just its *type* here is erased at compile time -- the same
// pattern shared/types.ts already uses for ContentBlock/Usage from
// ../main/jsonl/rows. No runtime code (and no electron) crosses into this
// module, which the renderer also imports.
import type { StreamedRow } from '../main/jsonl/stream'

/** Channel names for the write-path engine IPC surface (Plan 2 Task 6).
 *  `send`/`interrupt`/`resolvePermission` are fire-and-forget commands
 *  (renderer -> main, no reply expected -- `ipcRenderer.send` /
 *  `ipcMain.on`); `event`/`rows`/`permission` are broadcasts the main process
 *  pushes to the renderer (`webContents.send` / `ipcRenderer.on`), same shape
 *  as Plan 1's `indexProgress` channel. */
export const ENGINE_IPC = {
  send: 'engine:send',
  interrupt: 'engine:interrupt',
  resolvePermission: 'engine:resolvePermission',
  setSessionOverrides: 'engine:setSessionOverrides',
  newChat: 'engine:newChat',
  listEngines: 'engine:list',
  killEngine: 'engine:kill',
  pickDirectory: 'dialog:pickDirectory',
  event: 'engine:event',
  rows: 'engine:rows',
  permission: 'engine:permission',
  indexed: 'engine:indexed',
  isSessionLive: 'engine:isSessionLive',
  turnInfo: 'engine:turnInfo',
  backgroundTasks: 'engine:backgroundTasks',
  /** invoke: the chat's current external lock (a terminal holding it), or null. */
  getLock: 'engine:getLock',
  /** invoke: open the chat in a real Claude Code terminal (claude --resume). */
  openInTerminal: 'engine:openInTerminal',
  /** invoke: /clear -- open a new chat in the same folder with the same settings. */
  clearChat: 'engine:clearChat',
  /** invoke: what Claude Code has available for a folder (commands, skills). */
  claudeInfo: 'engine:claudeInfo',
  /** invoke: how this chat's running process sees its MCP servers, or null. */
  mcpStatus: 'engine:mcpStatus',
  /** invoke: reconnect one MCP server in this chat's running process. */
  mcpReconnect: 'engine:mcpReconnect',
  /** invoke: start a folder's MCP servers in a brief process and report on them. */
  mcpCheck: 'engine:mcpCheck',
  /** invoke: open `claude mcp login` in a terminal. */
  mcpLogin: 'engine:mcpLogin',
  /** invoke: end the idle terminal holding a chat, so ClaudeCord can use it. */
  hijackChat: 'engine:hijackChat',
  showProjectFolder: 'engine:showProjectFolder',
  memoryList: 'engine:memoryList',
  memoryRead: 'engine:memoryRead',
  memorySave: 'engine:memorySave',
  /** invoke: how full this chat's context is, from its running process. */
  contextUsage: 'engine:contextUsage',
  getProjectSettings: 'engine:getProjectSettings',
  /** invoke: the settings saved for a folder, for the New Chat dialog. */
  folderSettings: 'engine:folderSettings',
  setProjectSettings: 'engine:setProjectSettings',
  /** invoke: run a `!` command in the chat's folder. */
  shellRun: 'engine:shellRun',
  shellStop: 'engine:shellStop',
  shellDismiss: 'engine:shellDismiss',
  shellList: 'engine:shellList',
  /** broadcast: (sessionPk, ShellRun[]) whenever a chat's `!` commands change. */
  shellChanged: 'engine:shellChanged',
  /** invoke: whether a new chat may start in a folder without asking. */
  folderTrust: 'engine:folderTrust',
  trustFolder: 'engine:trustFolder',
  /** invoke: is the GitHub CLI installed and signed in. */
  githubStatus: 'engine:githubStatus',
  /** invoke: the user's repos that have no project yet. */
  githubRepos: 'engine:githubRepos',
  /** invoke: clone or pull a repo, ready for a new chat there. */
  githubPrepare: 'engine:githubPrepare',
  /** broadcast: (sessionPk, ExternalLock | null) whenever a chat's lock changes. */
  lockChanged: 'engine:lockChanged',
  /** invoke: every chat currently under Remote Control. */
  listRemote: 'engine:listRemote',
  /** broadcast: (RemoteSession[]) whenever that set changes. */
  remoteChanged: 'engine:remoteChanged'
} as const

export type EngineImageInput = { mediaType: string; dataBase64: string }

/** Everything a New-Chat dialog (Plan 2 Task 8) submits to create a fresh
 *  chat: a working directory (required), whether to run with
 *  `--dangerously-skip-permissions`, and optional model/effort/name. The
 *  canonical definition lives here (the IPC boundary both the renderer's
 *  dialog and the main process's `startNewChat` cross) -- `src/renderer/
 *  lib.ts` re-exports it via a type-only import so `resolveNewProjectOptions`
 *  never has to duplicate the shape. */
export type NewProjectOptions = {
  cwd: string
  skipPermissions: boolean
  model?: string
  effort?: string
  name?: string
}

/** Result of `engine:newChat`: either the new session's catalog identity
 *  (sessionPk to address it by, plus its durable session_id/uuid), or a
 *  reason it couldn't be created -- e.g. the chosen cwd doesn't exist on
 *  disk. Never throws across the IPC boundary; the dialog surfaces `error`
 *  to the user instead. */
export type NewChatOutcome =
  | { ok: true; sessionPk: number; sessionId: string }
  | { ok: false; error: string }

export type ClearChatOutcome =
  | { ok: true; cwd: string; sessionId: string; unchanged: boolean }
  | { ok: false; error: string }

export type EngineApi = {
  /** /clear: leaves this chat in the history and opens a new one in its folder
   *  with the same settings. `unchanged` when this chat has no messages yet. */
  clearChat(sessionPk: number): Promise<ClearChatOutcome>
  /** What Claude Code offers for a folder (null: the home folder). Starts a brief
   *  process the first time, then caches; uses no tokens. */
  claudeInfo(cwd: string | null, refresh?: boolean): Promise<ClaudeInfoResult>
  /** Null when the chat has no process running. */
  mcpStatus(sessionPk: number): Promise<McpServerStatus[] | null>
  mcpReconnect(sessionPk: number, name: string): Promise<McpCheckResult>
  /** Starts the folder's MCP servers briefly, as a chat would. Uses no tokens. */
  mcpCheck(cwd: string | null): Promise<McpCheckResult>
  mcpLogin(cwd: string | null, name: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Ends the terminal holding this chat. Refused unless it's idle, waiting at its prompt. */
  hijackChat(sessionPk: number): Promise<{ ok: true } | { ok: false; error: string }>
  /** Opens the project's folder in File Explorer. */
  showProjectFolder(projectId: number): Promise<{ ok: true } | { ok: false; error: string }>
  /** The files that shape what Claude remembers for a project. */
  memoryList(projectId: number): Promise<MemoryFile[]>
  memoryRead(projectId: number, fileId: string): Promise<MemoryFileContent>
  /** `expectedMtimeMs` is from the read: saving refuses if the file has changed since. */
  memorySave(projectId: number, fileId: string, text: string, expectedMtimeMs: number | null): Promise<MemorySaveResult>
  /** Null when the chat has no process running. */
  contextUsage(sessionPk: number): Promise<ContextUsage | null>
  /** The settings of the project this chat belongs to. */
  getProjectSettings(sessionPk: number): Promise<ProjectSettings>
  folderSettings(cwd: string): Promise<ProjectSettings>
  setProjectSettings(sessionPk: number, patch: Partial<ProjectSettings>): Promise<ProjectSettings>
  /** Runs a command in the chat's folder, without Claude. */
  shellRun(sessionPk: number, command: string): Promise<void>
  shellStop(id: string): Promise<void>
  /** Stops it if running, and keeps it from going to Claude. */
  shellDismiss(id: string): Promise<void>
  shellList(sessionPk: number): Promise<ShellRun[]>
  onShellChanged(cb: (sessionPk: number, runs: ShellRun[]) => void): () => void
  folderTrust(cwd: string): Promise<FolderTrust>
  trustFolder(cwd: string): Promise<void>
  githubStatus(): Promise<GithubStatus>
  githubRepos(): Promise<GithubRepoList>
  githubPrepare(options: { repo: string; cwd: string }): Promise<PrepareRepoOutcome>
  send(sessionPk: number, text: string, images?: EngineImageInput[]): void
  interrupt(sessionPk: number): void
  resolvePermission(
    id: string,
    decision: 'allow' | 'allow_always' | 'deny',
    editedInput?: unknown,
    denyMessage?: string
  ): void
  /** Live per-chat model/effort override, applied on the NEXT turn (a spawned
   *  transport can't change model mid-flight). Fire-and-forget; omit a field
   *  to leave it at the coordinator's default. Wired to the chat header's
   *  model/effort selectors. */
  setSessionOverrides(sessionPk: number, overrides: { model?: string; effort?: string }): void
  /** Registers a brand-new chat (Task 8) and returns its catalog identity.
   *  Does not spawn anything -- the pool spawns lazily on the first
   *  Composer send, same as any other session. */
  newChat(options: NewProjectOptions): Promise<NewChatOutcome>
  /** Snapshot of every live engine process for the pool HUD. */
  listEngines(): Promise<EngineSnapshot[]>
  /** Gracefully stop the engine with this pid; resolves true if one was found. */
  killEngine(pid: number): Promise<boolean>
  /** Opens a native "choose a folder" dialog for the New-Chat working
   *  directory field. Resolves to the chosen absolute path, or null if the
   *  user cancelled. */
  pickDirectory(): Promise<string | null>
  /** Whether the pool currently owns a live transport for this session, so
   *  App can re-derive `running` when switching back to a streaming chat
   *  (Plan 2 review Finding #6 / Plan 3 Task 8). */
  isSessionLive(sessionPk: number): Promise<boolean>
  /** The open chat's running turn, or null when none is running. */
  turnInfo(sessionPk: number): Promise<TurnInfo | null>
  backgroundTasks(sessionPk: number): Promise<BackgroundTask[]>
  /** Returns an unsubscribe function, matching Plan 1's onIndexProgress. */
  onEvent(cb: (sessionPk: number, e: LiveEvent) => void): () => void
  onRows(cb: (sessionPk: number, rows: StreamedRow[]) => void): () => void
  onPermission(cb: (sessionPk: number, req: PermissionRequest) => void): () => void
  /** Broadcasts once a live turn's durable rows have been synced into the
   *  catalog (Task 10 review Finding 1's fix -- see engine-ipc.ts's
   *  indexDebouncer): the catalog is now current for `sessionPk`, so a
   *  renderer with that session open should reload its transcript via
   *  `loadTranscript` to replace the live-appended render with the
   *  authoritative, freshly-indexed one. */
  onIndexed(cb: (sessionPk: number) => void): () => void
  /** The process outside ClaudeCord (a terminal) holding this chat, or null.
   *  While non-null the chat must be read-only. */
  getLock(sessionPk: number): Promise<ExternalLock | null>
  /** Fires when a chat is taken over by / released from an outside process. */
  onLockChanged(cb: (sessionPk: number, lock: ExternalLock | null) => void): () => void
  /** Opens the chat in an interactive Claude Code terminal (for /mcp, /login…). */
  openInTerminal(sessionPk: number): Promise<{ ok: true } | { ok: false; error: string }>
  /** Chats currently under Remote Control (/rc). */
  listRemote(): Promise<RemoteSession[]>
  onRemoteChanged(cb: (remote: RemoteSession[]) => void): () => void
}

export type { PermissionDecision }
