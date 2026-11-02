import { app, ipcMain, net, shell, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { UPDATE_IPC, type UpdateState, type UpdateStatus } from '../shared/update-types'
import { compareVersions } from '../shared/semver'

/** Self-update. Installed (NSIS) builds use electron-updater against the
 *  GitHub Releases feed electron-builder publishes (latest.yml): check, download
 *  in the background, then "Restart to update". The portable exe can't replace
 *  itself, so it asks the GitHub API for the latest release and offers a link.
 *  Development runs never update. */

const OWNER = 'niftiest'
const REPO = 'ClaudeCord'
const FIRST_CHECK_DELAY_MS = 15_000
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000
const RETRY_AFTER_MS = 2 * 60 * 1000
const MAX_RETRIES = 3

export type UpdaterHandle = { dispose(): void }

export function registerUpdater(window: BrowserWindow, opts: { autoCheck: () => boolean }): UpdaterHandle {
  const channel: UpdateStatus['channel'] = !app.isPackaged ? 'dev'
    : process.env.PORTABLE_EXECUTABLE_DIR !== undefined ? 'portable' : 'installer'
  let state: UpdateState = channel === 'dev'
    ? { state: 'unsupported', reason: 'Updates are only available in the installed app.' }
    : { state: 'idle' }

  const status = (): UpdateStatus => ({ ...state, currentVersion: app.getVersion(), channel })
  const set = (next: UpdateState): void => {
    state = next
    if (!window.isDestroyed()) window.webContents.send(UPDATE_IPC.status, status())
  }

  if (channel === 'installer') {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => set({ state: 'none', checkedAt: Date.now() }))
    autoUpdater.on('update-available', info => set({ state: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('download-progress', p => {
      const version = state.state === 'downloading' ? state.version : ''
      set({ state: 'downloading', version, percent: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', info => set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', err => set({ state: 'error', message: friendlyError(err) }))
  }

  let checking = false
  async function check(): Promise<UpdateStatus> {
    if (channel === 'dev' || checking) return status()
    // A downloaded update is waiting -- don't start over.
    if (state.state === 'ready' || state.state === 'downloading') return status()
    checking = true
    try {
      if (channel === 'installer') {
        await autoUpdater.checkForUpdates()
      } else {
        set({ state: 'checking' })
        set(await checkPortable())
      }
    } catch (err) {
      set({ state: 'error', message: friendlyError(err) })
    } finally {
      checking = false
    }
    return status()
  }

  ipcMain.handle(UPDATE_IPC.getStatus, () => status())
  ipcMain.handle(UPDATE_IPC.check, () => check())
  ipcMain.handle(UPDATE_IPC.install, () => {
    if (channel === 'installer' && state.state === 'ready') {
      // Silent install, then relaunch. The app's before-quit handlers still run.
      setImmediate(() => autoUpdater.quitAndInstall(true, true))
    }
  })
  ipcMain.handle(UPDATE_IPC.openDownload, () => {
    const url = state.state === 'available' && state.url !== null ? state.url : `https://github.com/${OWNER}/${REPO}/releases/latest`
    void shell.openExternal(url)
  })

  const timers: NodeJS.Timeout[] = []
  if (channel !== 'dev') {
    // An automatic check that fails (e.g. the network isn't up yet right after
    // login) is retried a few times, a couple of minutes apart, instead of
    // waiting for the next 6-hourly check.
    let retries = 0
    const auto = (): void => {
      if (!opts.autoCheck()) return
      void check().then(s => {
        if (s.state === 'error' && retries < MAX_RETRIES) {
          retries++
          timers.push(setTimeout(auto, RETRY_AFTER_MS))
        } else if (s.state !== 'error') {
          retries = 0
        }
      })
    }
    timers.push(setTimeout(auto, FIRST_CHECK_DELAY_MS))
    timers.push(setInterval(() => { retries = 0; auto() }, RECHECK_EVERY_MS))
  }

  return {
    dispose() {
      for (const t of timers) clearTimeout(t)
      for (const ch of [UPDATE_IPC.getStatus, UPDATE_IPC.check, UPDATE_IPC.install, UPDATE_IPC.openDownload]) ipcMain.removeHandler(ch)
    }
  }
}

/** Portable builds: compare against the latest published GitHub release. */
async function checkPortable(): Promise<UpdateState> {
  const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudeCord' }
  })
  if (res.status === 404) return { state: 'none', checkedAt: Date.now() } // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body = await res.json() as { tag_name?: string; html_url?: string }
  const latest = (body.tag_name ?? '').replace(/^v/i, '')
  if (latest.length > 0 && compareVersions(latest, app.getVersion()) > 0) {
    return { state: 'available', version: latest, url: body.html_url ?? null }
  }
  return { state: 'none', checkedAt: Date.now() }
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Keep the underlying reason visible so a failure can be diagnosed.
  const detail = msg.split('\n')[0]!.slice(0, 160)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(msg)) {
    return `Couldn't reach GitHub. Check your internet connection. (${detail})`
  }
  if (/\b404\b/.test(msg)) return 'No published release was found yet.'
  return detail
}
