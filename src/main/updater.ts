import { app, ipcMain, net, powerMonitor, shell, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { autoUpdater } from 'electron-updater'
import { canRestartForUpdate, UPDATE_IPC, type UpdateState, type UpdateStatus } from '../shared/update-types'
import { compareVersions } from '../shared/semver'
import { downloadPortable, handoffArgs, pickPortableAsset, previousFromArgv, type PortableAsset } from './portable-update'

/** Self-update. Installed (NSIS) builds use electron-updater against the
 *  GitHub Releases feed electron-builder publishes (latest.yml). The portable exe
 *  asks the GitHub API for the latest release and downloads it beside itself (see
 *  portable-update.ts). Either way the update then waits for "Restart to update" or
 *  for ClaudeCord to be idle. Development runs never update. */

const OWNER = 'niftiest'
const REPO = 'ClaudeCord'
const FIRST_CHECK_DELAY_MS = 15_000
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000
const RETRY_AFTER_MS = 2 * 60 * 1000
const MAX_RETRIES = 3
const IDLE_CHECK_EVERY_MS = 60 * 1000
/** Set only when building a test copy, to update from a local server. */
const FEED_OVERRIDE = import.meta.env.MAIN_VITE_UPDATE_FEED as string | undefined
const LATEST_RELEASE = FEED_OVERRIDE ?? `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const TRUSTED_DOWNLOAD = `https://github.com/${OWNER}/${REPO}/releases/download/`

declare global {
  interface ImportMeta { readonly env: Record<string, unknown> }
}

export type UpdaterHandle = { dispose(): void }

export function registerUpdater(window: BrowserWindow, opts: { autoCheck: () => boolean; autoInstall: () => boolean; activeWork: () => number }): UpdaterHandle {
  const channel: UpdateStatus['channel'] = !app.isPackaged ? 'dev'
    : process.env.PORTABLE_EXECUTABLE_DIR !== undefined ? 'portable' : 'installer'
  let state: UpdateState = channel === 'dev'
    ? { state: 'unsupported', reason: 'Updates are only available in the installed app.' }
    : { state: 'idle' }

  const justUpdated = previousFromArgv(process.argv) !== null
  const status = (): UpdateStatus => ({ ...state, currentVersion: app.getVersion(), channel, justUpdated })
  const set = (next: UpdateState): void => {
    state = next
    if (!window.isDestroyed()) window.webContents.send(UPDATE_IPC.status, status())
  }

  if (channel === 'installer') {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = opts.autoInstall()
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

  /** The downloaded exe waiting to take over (portable builds). */
  let portableExe: string | null = null
  /** Something unsent in the window; only a person should lose that. */
  let hold = false

  async function fetchPortable(): Promise<void> {
    const found = await checkPortable()
    if (found.state !== 'available') { set(found); return }
    const dir = process.env.PORTABLE_EXECUTABLE_DIR
    const failed = (reason: string): void => set({ ...found, reason })
    if (found.asset === null || dir === undefined) { failed('this release has no portable download.'); return }
    set({ state: 'downloading', version: found.version, percent: 0 })
    try {
      portableExe = await downloadPortable(url => net.fetch(url, { headers: { 'User-Agent': 'ClaudeCord' } }), found.asset, dir,
        percent => set({ state: 'downloading', version: found.version, percent }))
      set({ state: 'ready', version: found.version })
    } catch (err) {
      failed(`${friendlyError(err)}.`)
    }
  }

  /** Starts the new exe, then quits. It waits for this one to exit before opening. */
  function handOffToPortable(exe: string): void {
    const current = process.env.PORTABLE_EXECUTABLE_FILE
    if (current === undefined) return
    const hidden = !window.isDestroyed() && (!window.isVisible() || window.isMinimized())
    const env = { ...process.env }
    delete env.PORTABLE_EXECUTABLE_DIR
    delete env.PORTABLE_EXECUTABLE_FILE
    delete env.PORTABLE_EXECUTABLE_APP_FILENAME
    const child = spawn(exe, handoffArgs(process.argv.slice(1), current, hidden), { detached: true, stdio: 'ignore', env })
    child.once('error', err => set({ state: 'error', message: `Couldn't start the new version: ${friendlyError(err)}` }))
    child.once('spawn', () => { child.unref(); app.quit() })
  }

  function restartIntoUpdate(): void {
    if (state.state !== 'ready') return
    if (channel === 'installer') {
      // Silent install, then relaunch. The app's before-quit handlers still run.
      setImmediate(() => autoUpdater.quitAndInstall(true, true))
    } else if (portableExe !== null) {
      handOffToPortable(portableExe)
    }
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
        await fetchPortable()
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
  ipcMain.handle(UPDATE_IPC.install, () => { restartIntoUpdate() })
  ipcMain.handle(UPDATE_IPC.setHold, (_e, value: unknown) => { hold = value === true })
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
    timers.push(setInterval(() => {
      const autoInstall = opts.autoInstall()
      // Turned off means off: an installed build otherwise applies the update on quit.
      if (channel === 'installer') autoUpdater.autoInstallOnAppQuit = autoInstall
      if (canRestartForUpdate({ autoInstall, ready: state.state === 'ready', unsent: hold, activeWork: opts.activeWork(), idleSeconds: powerMonitor.getSystemIdleTime() })) {
        restartIntoUpdate()
      }
    }, IDLE_CHECK_EVERY_MS))
  }

  return {
    dispose() {
      for (const t of timers) clearTimeout(t)
      for (const ch of [UPDATE_IPC.getStatus, UPDATE_IPC.check, UPDATE_IPC.install, UPDATE_IPC.setHold, UPDATE_IPC.openDownload]) ipcMain.removeHandler(ch)
    }
  }
}

/** Portable builds: compare against the latest published GitHub release. */
async function checkPortable(): Promise<{ state: 'none'; checkedAt: number } | { state: 'available'; version: string; url: string | null; asset: PortableAsset | null }> {
  const res = await net.fetch(LATEST_RELEASE, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudeCord' }
  })
  if (res.status === 404) return { state: 'none', checkedAt: Date.now() } // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body = await res.json() as { tag_name?: string; html_url?: string; assets?: unknown }
  const latest = (body.tag_name ?? '').replace(/^v/i, '')
  if (latest.length > 0 && compareVersions(latest, app.getVersion()) > 0) {
    const asset = pickPortableAsset(body.assets)
    // Only ever run what this repository published.
    const trusted = asset !== null && (FEED_OVERRIDE !== undefined || asset.url.startsWith(TRUSTED_DOWNLOAD))
    return { state: 'available', version: latest, url: body.html_url ?? null, asset: trusted ? asset : null }
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
