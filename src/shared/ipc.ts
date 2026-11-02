import type { ProjectSummary, SessionSummary, SearchHit, TranscriptPage, IndexProgress, ChannelRow } from './types'
import type { ChannelIcon, ChannelGroup, AppSettings } from './shell-types'
import type { McpServerInfo, SkillInfo } from '../main/mcp-skills'
import type { FsEntry } from '../main/fs-tree'
import type { ImageModelInfo, OpenRouterUsage } from '../main/openrouter'

export type { McpServerInfo, SkillInfo } from '../main/mcp-skills'
export type { FsEntry } from '../main/fs-tree'
export type { ImageModelInfo, OpenRouterUsage } from '../main/openrouter'

export type { IndexProgress } from './types'

export const IPC = {
  listProjects: 'catalog:listProjects',
  listSessions: 'catalog:listSessions',
  loadTranscript: 'catalog:loadTranscript',
  // Refresh-on-open: re-index one session if its file changed on disk since
  // the catalog last saw it (e.g. continued from a terminal).
  syncSessionIfStale: 'catalog:syncSessionIfStale',
  listSubagents: 'catalog:listSubagents',
  search: 'catalog:search',
  indexRun: 'index:run',
  indexProgress: 'index:progress',
  // Channel metadata (Plan 3 Task 2) -- rename/favorite/group/icon, surfaced
  // in the nav and edited via ChannelContextMenu/IconPicker. All backed by
  // src/main/catalog/metadata.ts's repos; these handlers are thin
  // passthroughs (see src/main/ipc.ts).
  listChannels: 'catalog:listChannels',
  totalCost: 'catalog:totalCost',
  listGroups: 'catalog:listGroups',
  setFriendlyName: 'catalog:setFriendlyName',
  setStarred: 'catalog:setStarred',
  setChannelIcon: 'catalog:setChannelIcon',
  setChannelGroup: 'catalog:setChannelGroup',
  createGroup: 'catalog:createGroup',
  renameGroup: 'catalog:renameGroup',
  setGroupIcon: 'catalog:setGroupIcon',
  deleteGroup: 'catalog:deleteGroup',
  // Hide (reversible) / permanently delete a channel and its transcripts.
  setChannelHidden: 'catalog:setChannelHidden',
  deleteChannel: 'catalog:deleteChannel',
  // Read-only MCP servers + skills views (the GUI stand-in for /mcp, /skills)
  listMcpServers: 'catalog:listMcpServers',
  listSkills: 'catalog:listSkills',
  fsTree: 'fs:tree',
  openLink: 'shell:openLink',
  listProjectFiles: 'fs:listProjectFiles',
  generateAvatar: 'openrouter:generateAvatar',
  listImageModels: 'openrouter:listImageModels',
  openRouterUsage: 'openrouter:usage',
  saveImage: 'fs:saveImage',
  // App settings (Plan 3 Task 4/5)
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  isElevated: 'settings:isElevated',
  // Fire-and-forget: the renderer finished its first load -- main reveals the
  // (until then hidden) window and closes the launch splash.
  appReady: 'app:ready'
} as const

export type ClaudeCordApi = {
  listProjects(): Promise<ProjectSummary[]>
  listSessions(projectId: number): Promise<SessionSummary[]>
  loadTranscript(sessionPk: number, opts?: { before?: number; limit?: number }): Promise<TranscriptPage>
  /** Re-indexes the session if its transcript changed on disk since the
   *  catalog last recorded it; resolves true when it did (nav may be stale). */
  syncSessionIfStale(sessionPk: number): Promise<boolean>
  listSubagents(toolUseId: string): Promise<SessionSummary[]>
  search(query: string): Promise<SearchHit[]>
  runIndex(): Promise<void>
  /** Tells main the first load is done: show the window, close the splash. */
  appReady(): void
  onIndexProgress(cb: (p: IndexProgress) => void): () => void

  /** ProjectSummary rows merged with their ChannelMeta (Plan 3 Task 2) -- the
   *  nav's actual data source, superseding listProjects for display. */
  listChannels(): Promise<ChannelRow[]>
  /** Total estimated USD cost across all sessions -- the nav header figure. */
  totalCost(): Promise<number>
  listGroups(): Promise<ChannelGroup[]>
  setFriendlyName(dirName: string, name: string | null): Promise<void>
  setStarred(dirName: string, starred: boolean): Promise<void>
  setChannelIcon(dirName: string, icon: ChannelIcon): Promise<void>
  setChannelGroup(dirName: string, groupId: number | null): Promise<void>
  createGroup(name: string): Promise<number>
  renameGroup(id: number, name: string): Promise<void>
  setGroupIcon(id: number, icon: ChannelIcon): Promise<void>
  deleteGroup(id: number): Promise<void>
  /** Reversibly remove a channel from the main nav (into the Hidden section),
   *  leaving its transcripts on disk. */
  setChannelHidden(dirName: string, hidden: boolean): Promise<void>
  /** PERMANENTLY delete a channel: removes its whole project directory from
   *  ~/.claude/projects and its catalog rows. Irreversible. */
  deleteChannel(dirName: string): Promise<{ deletedSessions: number }>
  /** Read-only list of configured MCP servers (user + the open project's),
   *  for the MCP & Skills panel. */
  listMcpServers(projectCwd?: string | null): Promise<McpServerInfo[]>
  /** Read-only list of installed skills (user + the open project's). */
  listSkills(projectCwd?: string | null): Promise<SkillInfo[]>
  /** Bounded project file tree + git status for the context rail's Files tab. */
  fsTree(cwd: string | null): Promise<FsEntry[]>
  /** Opens a web or mail link from a chat in the default browser. Anything else is ignored. */
  openLink(url: string): Promise<void>
  /** Project paths for the composer's @ picker (folders end in "/"). */
  listProjectFiles(cwd: string | null): Promise<string[]>
  /** Generate a chat avatar from a text prompt via OpenRouter (key + model from
   *  settings). Returns a data: URL or an error message; never throws. */
  generateAvatar(prompt: string, size?: string, model?: string): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>
  /** Live image-generation models + pricing from OpenRouter (public; no key). */
  listImageModels(): Promise<ImageModelInfo[]>
  /** This key's OpenRouter spend + remaining balance; null with no key / on error. */
  openRouterUsage(): Promise<OpenRouterUsage | null>
  /** Save an image data URL to `relPath` inside a chat's working directory
   *  (path-guarded; won't overwrite). Returns the saved absolute path. */
  saveImage(cwd: string, relPath: string, dataUrl: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  isElevated(): Promise<boolean>
}
