/** Self-update surface (renderer <-> main). Installed builds update themselves
 *  from GitHub Releases (download in the background, restart to apply); the
 *  portable exe can't replace itself, so it only reports a newer release and
 *  links to it; development runs don't update at all. */

export const UPDATE_IPC = {
  getStatus: 'update:getStatus',
  check: 'update:check',
  install: 'update:install',
  openDownload: 'update:openDownload',
  status: 'update:status'
} as const

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; checkedAt: number }
  | { state: 'available'; version: string; url: string | null }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; reason: string }

export type UpdateStatus = UpdateState & {
  currentVersion: string
  /** 'installer' updates itself; 'portable' only links to the download; 'dev' never updates. */
  channel: 'installer' | 'portable' | 'dev'
}

export type UpdateApi = {
  getUpdateStatus(): Promise<UpdateStatus>
  /** Manual "Check for updates". */
  checkForUpdates(): Promise<UpdateStatus>
  /** Quit and install a downloaded update (installer builds). */
  installUpdate(): Promise<void>
  /** Open the release page for a newer version (portable builds). */
  openUpdateDownload(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
}
