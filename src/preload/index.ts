import type { ShellRun } from '../shared/shell-run-types'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type ClaudeCordApi, type IndexProgress } from '../shared/ipc'
import { ENGINE_IPC, type EngineApi, type NewProjectOptions, type NewChatOutcome } from '../shared/engine-ipc-contract'
import type { LiveEvent, PermissionRequest, ExternalLock, RemoteSession } from '../shared/engine-types'
import type { StreamedRow } from '../main/jsonl/stream'
import { MANAGE_IPC, type ContentSearchEvent, type ManageApi } from '../shared/manage-types'
import { UPDATE_IPC, type UpdateApi, type UpdateStatus } from '../shared/update-types'
import { CLAUDE_SETTINGS_IPC, type AutoCleanResult, type ClaudeSettingsApi } from '../shared/claude-settings-types'

const api: ClaudeCordApi & EngineApi = {
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  listSessions: projectId => ipcRenderer.invoke(IPC.listSessions, projectId),
  loadTranscript: (sessionPk, opts) => ipcRenderer.invoke(IPC.loadTranscript, sessionPk, opts),
  syncSessionIfStale: sessionPk => ipcRenderer.invoke(IPC.syncSessionIfStale, sessionPk),
  listSubagents: toolUseId => ipcRenderer.invoke(IPC.listSubagents, toolUseId),
  search: query => ipcRenderer.invoke(IPC.search, query),
  runIndex: () => ipcRenderer.invoke(IPC.indexRun),
  appReady: () => ipcRenderer.send(IPC.appReady),
  onIndexProgress: cb => {
    const listener = (_e: IpcRendererEvent, p: IndexProgress) => cb(p)
    ipcRenderer.on(IPC.indexProgress, listener)
    return () => { ipcRenderer.off(IPC.indexProgress, listener) }
  },

  listChannels: () => ipcRenderer.invoke(IPC.listChannels),
  totalCost: () => ipcRenderer.invoke(IPC.totalCost),
  listGroups: () => ipcRenderer.invoke(IPC.listGroups),
  setFriendlyName: (dirName, name) => ipcRenderer.invoke(IPC.setFriendlyName, dirName, name),
  setStarred: (dirName, starred) => ipcRenderer.invoke(IPC.setStarred, dirName, starred),
  setChannelIcon: (dirName, icon) => ipcRenderer.invoke(IPC.setChannelIcon, dirName, icon),
  setChannelGroup: (dirName, groupId) => ipcRenderer.invoke(IPC.setChannelGroup, dirName, groupId),
  createGroup: name => ipcRenderer.invoke(IPC.createGroup, name),
  renameGroup: (id, name) => ipcRenderer.invoke(IPC.renameGroup, id, name),
  setGroupIcon: (id, icon) => ipcRenderer.invoke(IPC.setGroupIcon, id, icon),
  deleteGroup: id => ipcRenderer.invoke(IPC.deleteGroup, id),
  setChannelHidden: (dirName, hidden) => ipcRenderer.invoke(IPC.setChannelHidden, dirName, hidden),
  deleteChannel: dirName => ipcRenderer.invoke(IPC.deleteChannel, dirName),
  listMcpServers: (projectCwd) => ipcRenderer.invoke(IPC.listMcpServers, projectCwd),
  listSkills: (projectCwd) => ipcRenderer.invoke(IPC.listSkills, projectCwd),
  fsTree: (cwd) => ipcRenderer.invoke(IPC.fsTree, cwd),
  openLink: (url) => ipcRenderer.invoke(IPC.openLink, url),
  listProjectFiles: (cwd) => ipcRenderer.invoke(IPC.listProjectFiles, cwd),
  generateAvatar: (prompt, size, model) => ipcRenderer.invoke(IPC.generateAvatar, prompt, size, model),
  listImageModels: () => ipcRenderer.invoke(IPC.listImageModels),
  openRouterUsage: () => ipcRenderer.invoke(IPC.openRouterUsage),
  saveImage: (cwd, relPath, dataUrl) => ipcRenderer.invoke(IPC.saveImage, cwd, relPath, dataUrl),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: patch => ipcRenderer.invoke(IPC.updateSettings, patch),
  isElevated: () => ipcRenderer.invoke(IPC.isElevated),

  send: (sessionPk, text, images) => { ipcRenderer.send(ENGINE_IPC.send, sessionPk, text, images) },
  interrupt: sessionPk => { ipcRenderer.send(ENGINE_IPC.interrupt, sessionPk) },
  resolvePermission: (id, decision, editedInput, denyMessage) => {
    ipcRenderer.send(ENGINE_IPC.resolvePermission, id, decision, editedInput, denyMessage)
  },
  setSessionOverrides: (sessionPk, overrides) => {
    ipcRenderer.send(ENGINE_IPC.setSessionOverrides, sessionPk, overrides)
  },
  newChat: (options: NewProjectOptions): Promise<NewChatOutcome> => ipcRenderer.invoke(ENGINE_IPC.newChat, options),
  listEngines: () => ipcRenderer.invoke(ENGINE_IPC.listEngines),
  killEngine: (pid: number) => ipcRenderer.invoke(ENGINE_IPC.killEngine, pid),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(ENGINE_IPC.pickDirectory),
  isSessionLive: (sessionPk: number): Promise<boolean> => ipcRenderer.invoke(ENGINE_IPC.isSessionLive, sessionPk),
  onEvent: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, ev: LiveEvent) => cb(sessionPk, ev)
    ipcRenderer.on(ENGINE_IPC.event, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.event, listener) }
  },
  onRows: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, rows: StreamedRow[]) => cb(sessionPk, rows)
    ipcRenderer.on(ENGINE_IPC.rows, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.rows, listener) }
  },
  onPermission: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, req: PermissionRequest) => cb(sessionPk, req)
    ipcRenderer.on(ENGINE_IPC.permission, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.permission, listener) }
  },
  onIndexed: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number) => cb(sessionPk)
    ipcRenderer.on(ENGINE_IPC.indexed, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.indexed, listener) }
  },
  getLock: (sessionPk: number): Promise<ExternalLock | null> => ipcRenderer.invoke(ENGINE_IPC.getLock, sessionPk),
  openInTerminal: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.openInTerminal, sessionPk),
  clearChat: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.clearChat, sessionPk),
  claudeInfo: (cwd: string | null, refresh?: boolean) => ipcRenderer.invoke(ENGINE_IPC.claudeInfo, cwd, refresh),
  mcpStatus: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.mcpStatus, sessionPk),
  mcpReconnect: (sessionPk: number, name: string) => ipcRenderer.invoke(ENGINE_IPC.mcpReconnect, sessionPk, name),
  mcpCheck: (cwd: string | null) => ipcRenderer.invoke(ENGINE_IPC.mcpCheck, cwd),
  mcpLogin: (cwd: string | null, name: string) => ipcRenderer.invoke(ENGINE_IPC.mcpLogin, cwd, name),
  hijackChat: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.hijackChat, sessionPk),
  showProjectFolder: (projectId: number) => ipcRenderer.invoke(ENGINE_IPC.showProjectFolder, projectId),
  memoryList: (projectId: number) => ipcRenderer.invoke(ENGINE_IPC.memoryList, projectId),
  memoryRead: (projectId: number, fileId: string) => ipcRenderer.invoke(ENGINE_IPC.memoryRead, projectId, fileId),
  memorySave: (projectId: number, fileId: string, text: string, expectedMtimeMs: number | null) => ipcRenderer.invoke(ENGINE_IPC.memorySave, projectId, fileId, text, expectedMtimeMs),
  contextUsage: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.contextUsage, sessionPk),
  getProjectSettings: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.getProjectSettings, sessionPk),
  folderSettings: (cwd: string) => ipcRenderer.invoke(ENGINE_IPC.folderSettings, cwd),
  setProjectSettings: (sessionPk: number, patch) => ipcRenderer.invoke(ENGINE_IPC.setProjectSettings, sessionPk, patch),
  shellRun: (sessionPk: number, command: string) => ipcRenderer.invoke(ENGINE_IPC.shellRun, sessionPk, command),
  shellStop: (id: string) => ipcRenderer.invoke(ENGINE_IPC.shellStop, id),
  shellDismiss: (id: string) => ipcRenderer.invoke(ENGINE_IPC.shellDismiss, id),
  shellList: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.shellList, sessionPk),
  onShellChanged: (cb) => {
    const listener = (_e: unknown, sessionPk: number, runs: ShellRun[]): void => cb(sessionPk, runs)
    ipcRenderer.on(ENGINE_IPC.shellChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.shellChanged, listener) }
  },
  folderTrust: (cwd: string) => ipcRenderer.invoke(ENGINE_IPC.folderTrust, cwd),
  trustFolder: (cwd: string) => ipcRenderer.invoke(ENGINE_IPC.trustFolder, cwd),
  onLockChanged: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, lock: ExternalLock | null) => cb(sessionPk, lock)
    ipcRenderer.on(ENGINE_IPC.lockChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.lockChanged, listener) }
  },
  listRemote: (): Promise<RemoteSession[]> => ipcRenderer.invoke(ENGINE_IPC.listRemote),
  onRemoteChanged: cb => {
    const listener = (_e: IpcRendererEvent, remote: RemoteSession[]) => cb(remote)
    ipcRenderer.on(ENGINE_IPC.remoteChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.remoteChanged, listener) }
  }
}

const manage: ManageApi = {
  planDelete: target => ipcRenderer.invoke(MANAGE_IPC.planDelete, target),
  checkSessions: target => ipcRenderer.invoke(MANAGE_IPC.checkSessions, target),
  endSessions: pids => ipcRenderer.invoke(MANAGE_IPC.endSessions, pids),
  executeDelete: (target, keys, restorePoint) => ipcRenderer.invoke(MANAGE_IPC.executeDelete, target, keys, restorePoint),
  showInFolder: path => ipcRenderer.invoke(MANAGE_IPC.showInFolder, path),

  manageProjects: () => ipcRenderer.invoke(MANAGE_IPC.listProjects),
  projectDetail: workingDir => ipcRenderer.invoke(MANAGE_IPC.projectDetail, workingDir),
  searchStart: (id, query) => ipcRenderer.invoke(MANAGE_IPC.searchStart, id, query),
  searchCancel: id => ipcRenderer.invoke(MANAGE_IPC.searchCancel, id),
  onSearchEvent: cb => {
    const listener = (_e: IpcRendererEvent, ev: ContentSearchEvent) => cb(ev)
    ipcRenderer.on(MANAGE_IPC.searchEvent, listener)
    return () => { ipcRenderer.off(MANAGE_IPC.searchEvent, listener) }
  },
  exportProjects: workingDirs => ipcRenderer.invoke(MANAGE_IPC.exportProjects, workingDirs),
  pickImport: () => ipcRenderer.invoke(MANAGE_IPC.pickImport),
  readArchive: zip => ipcRenderer.invoke(MANAGE_IPC.readArchive, zip),
  importArchive: zip => ipcRenderer.invoke(MANAGE_IPC.importArchive, zip),
  renamePlan: (oldDir, newDir) => ipcRenderer.invoke(MANAGE_IPC.renamePlan, oldDir, newDir),
  renameExecute: (oldDir, newDir, signature) => ipcRenderer.invoke(MANAGE_IPC.renameExecute, oldDir, newDir, signature),
  listRestorePoints: () => ipcRenderer.invoke(MANAGE_IPC.listRestorePoints),
  deleteRestorePoints: list => ipcRenderer.invoke(MANAGE_IPC.deleteRestorePoints, list),
  openRestorePointsFolder: () => ipcRenderer.invoke(MANAGE_IPC.openRestorePointsFolder),
  findNotes: rescan => ipcRenderer.invoke(MANAGE_IPC.findNotes, rescan),
  searchNotes: query => ipcRenderer.invoke(MANAGE_IPC.searchNotes, query),
  deleteNotes: list => ipcRenderer.invoke(MANAGE_IPC.deleteNotes, list),
  previewNote: path => ipcRenderer.invoke(MANAGE_IPC.previewNote, path),
  exportNotes: list => ipcRenderer.invoke(MANAGE_IPC.exportNotes, list),
  openInEditor: path => ipcRenderer.invoke(MANAGE_IPC.openInEditor, path),
  liveSessions: () => ipcRenderer.invoke(MANAGE_IPC.liveSessions)
}

const update: UpdateApi = {
  getUpdateStatus: () => ipcRenderer.invoke(UPDATE_IPC.getStatus),
  checkForUpdates: () => ipcRenderer.invoke(UPDATE_IPC.check),
  installUpdate: () => ipcRenderer.invoke(UPDATE_IPC.install),
  openUpdateDownload: () => ipcRenderer.invoke(UPDATE_IPC.openDownload),
  onUpdateStatus: cb => {
    const listener = (_e: IpcRendererEvent, s: UpdateStatus) => cb(s)
    ipcRenderer.on(UPDATE_IPC.status, listener)
    return () => { ipcRenderer.off(UPDATE_IPC.status, listener) }
  }
}

const claudeSettings: ClaudeSettingsApi = {
  claudeSettingsGet: target => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.get, target),
  claudeSettingsUpdate: (target, patch) => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.update, target, patch),
  retentionStatus: () => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.retentionStatus),
  retentionPreview: () => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.retentionPreview),
  retentionRunNow: () => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.retentionRunNow),
  onRetentionCleaned: cb => {
    const listener = (_e: IpcRendererEvent, r: AutoCleanResult) => cb(r)
    ipcRenderer.on(CLAUDE_SETTINGS_IPC.retentionCleaned, listener)
    return () => { ipcRenderer.off(CLAUDE_SETTINGS_IPC.retentionCleaned, listener) }
  },
  onOpenChat: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, dirName: string) => cb(sessionPk, dirName)
    ipcRenderer.on(CLAUDE_SETTINGS_IPC.openChat, listener)
    return () => { ipcRenderer.off(CLAUDE_SETTINGS_IPC.openChat, listener) }
  }
}

contextBridge.exposeInMainWorld('claudecord', { ...api, ...manage, ...update, ...claudeSettings })
