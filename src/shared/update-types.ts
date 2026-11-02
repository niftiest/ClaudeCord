/** Self-update surface (renderer <-> main). Installed and portable builds both
 *  download new versions from GitHub Releases by themselves and restart into them
 *  when idle; development runs don't update at all. */

export const UPDATE_IPC = {
  getStatus: 'update:getStatus',
  check: 'update:check',
  install: 'update:install',
  setHold: 'update:setHold',
  openDownload: 'update:openDownload',
  status: 'update:status'
} as const

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; checkedAt: number }
  /** Portable builds, when downloading it failed: `reason` says why, `url` is the release page. */
  | { state: 'available'; version: string; url: string | null; reason?: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; reason: string }

export type UpdateStatus = UpdateState & {
  currentVersion: string
  channel: 'installer' | 'portable' | 'dev'
  /** This launch is a portable update that just took over from the previous version. */
  justUpdated: boolean
}

export type UpdateApi = {
  getUpdateStatus(): Promise<UpdateStatus>
  /** Manual "Check for updates". */
  checkForUpdates(): Promise<UpdateStatus>
  /** Restart into a downloaded update. */
  installUpdate(): Promise<void>
  /** Don't restart by itself for now: there's something unsent in the window. */
  setUpdateHold(hold: boolean): Promise<void>
  /** Open the release page for a newer version (portable builds, if the download failed). */
  openUpdateDownload(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
}
