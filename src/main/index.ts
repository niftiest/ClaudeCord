import { app, BrowserWindow, Menu, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSplash, type Splash } from './splash'
import { IPC } from '../shared/ipc'
import { openCatalog } from './catalog/db'
import { registerIpc } from './ipc'
import { registerEngineIpc, type EngineIpcHandle } from './engine/engine-ipc'
import { registerManageIpc } from './manage-ipc'
import { registerSyncIpc, type SyncIpcHandle } from './sync-ipc'
import { registerUpdater } from './updater'
import { getSettings } from './catalog/settings'
import { AUTOSTART_ARG } from './ipc'
import { applyStartupSettings } from './elevation'
import { registerClaudeSettingsIpc } from './claude-settings-ipc'
import { createDesktop, type Desktop } from './desktop'
import { isDeletablePrevious, launchExePath, previousFromArgv, removePrevious, UPDATED_HIDDEN_ARG } from './portable-update'

// Module-level so every app-lifecycle listener below can reach the same
// handle -- `registerEngineIpc`'s own `dispose()` is idempotent (Plan 2
// review Fix 3), so it is safe for more than one of these overlapping events
// to fire for the same teardown (e.g. the window closing AND before-quit).
let engine: EngineIpcHandle | null = null
let sync: SyncIpcHandle | null = null
let mainWindow: BrowserWindow | null = null
let splash: Splash | null = null
let desktop: Desktop | null = null
/** True once the window has been shown for the first time (the splash is gone). */
let revealed = false
/** Set when the app is really quitting, so "close to tray" lets the window close. */
let quitting = false

/** Longest the splash may stand in for the main window. The splash tracks the
 *  startup index, so a big first-run archive legitimately takes a while; past
 *  this cap the main window is shown anyway (its own progress overlay takes
 *  over) so a stuck renderer can never strand the user on the splash. */
const SPLASH_MAX_MS = 120_000

/** Window icon for dev runs; a packaged build uses the icon embedded in the exe. */
function devIcon(): string | undefined {
  const p = join(app.getAppPath(), 'resources', 'icon.png')
  return existsSync(p) ? p : undefined
}

function createWindow(): void {
  const icon = devIcon()
  const db = openCatalog(join(app.getPath('userData'), 'catalog.db'))
  const startup = getSettings(db)
  // A login start with "Start minimised": no splash, window stays in the tray
  // (or minimised to the taskbar when there's no tray icon).
  const startHidden = (startup.startMinimized && process.argv.includes(AUTOSTART_ARG)) || process.argv.includes(UPDATED_HIDDEN_ARG)
  if (!startHidden) splash = createSplash(icon)
  // Older registrations didn't pass AUTOSTART_ARG; refresh the plain Run key
  // (the admin scheduled task is only rewritten from Settings, elevated).
  if (startup.startWithWindows && !startup.startWithAdmin && app.isPackaged) {
    applyStartupSettings({ startWithWindows: true, startWithAdmin: false, exePath: launchExePath(app.getPath('exe')), appArgs: [AUTOSTART_ARG] })
  }

  // Never open bigger than the screen: 1080p at 150% scaling is only 1280x720.
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(1600, workArea.width),
    height: Math.min(1000, workArea.height),
    // Hidden until the renderer reports it has loaded (app:ready) -- the
    // splash is all the user sees until then.
    show: false,
    title: 'ClaudeCord',
    ...(icon !== undefined ? { icon } : {}),
    backgroundColor: '#080B13',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow = win

  desktop = createDesktop(db, () => mainWindow, { quit: () => { quitting = true; app.quit() } })
  desktop.syncTray()

  const reveal = (): void => {
    if (revealed) return
    revealed = true
    clearTimeout(revealTimer)
    ipcMain.removeListener(IPC.appReady, onAppReady)
    if (!win.isDestroyed()) {
      if (!startHidden) {
        win.show()
        win.focus()
      } else if (!(desktop?.hasTray() ?? false)) {
        win.showInactive()
        win.minimize()
      }
    }
    splash?.close()
    splash = null
  }
  const onAppReady = (e: Electron.IpcMainEvent): void => { if (e.sender === win.webContents) reveal() }
  ipcMain.on(IPC.appReady, onAppReady)
  const revealTimer = setTimeout(reveal, SPLASH_MAX_MS)
  // A renderer that fails to load or crashes would never send app:ready --
  // show the window (with whatever error state it has) rather than hang.
  win.webContents.on('did-fail-load', reveal)
  win.webContents.on('render-process-gone', reveal)

  registerIpc(db, win, {
    onIndexProgress: p => splash?.showIndexProgress(p),
    onSettingsChanged: () => desktop?.syncTray()
  })
  engine = registerEngineIpc(db, win, {
    onEvent: (pk, e) => {
      desktop?.onEvent(pk, e)
      if (e.kind === 'result') sync?.turnEnded(pk)
    },
    onPermission: (pk, req) => desktop?.onPermission(pk, req)
  })
  sync = registerSyncIpc(db, win, engine)
  const manage = registerManageIpc(db, engine, undefined, (from, to) => { void sync?.projectFolderRenamed(from, to) })
  const claudeSettings = registerClaudeSettingsIpc(db, win, engine)
  const updater = registerUpdater(win, {
    autoCheck: () => getSettings(db).autoCheckUpdates,
    autoInstall: () => getSettings(db).autoInstallUpdates,
    activeWork: () => engine?.activeWork() ?? 0
  })

  // "Close button minimises to tray": hide instead of closing, unless the app
  // is quitting (tray menu, update install, Windows shutting down).
  win.on('close', e => {
    if (quitting || !getSettings(db).closeToTray || !(desktop?.hasTray() ?? false)) return
    e.preventDefault()
    win.hide()
  })
  win.on('closed', () => { desktop?.dispose(); desktop = null })
  win.on('closed', () => claudeSettings.dispose())
  win.on('closed', () => updater.dispose())
  win.on('closed', () => manage.dispose())
  win.on('closed', () => { sync?.dispose(); sync = null })
  win.on('closed', () => engine?.dispose())

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Drop Electron's default application menu (File / Edit / View / Window / Help)
// -- ClaudeCord is a chrome-less shell; none of those items apply. This also
// removes the menu bar from the window on Windows/Linux.
Menu.setApplicationMenu(null)
// Windows groups notifications (and the taskbar entry) by this id; it matches
// the installer's shortcut, so toasts show as "ClaudeCord".
if (process.platform === 'win32') app.setAppUserModelId('com.niftiestpixel.claudecord')

// One ClaudeCord at a time: a second launch (double-clicking the shortcut
// again) focuses the running window instead of starting a second app against
// the same catalog and the same claude sessions.
function start(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    const w = mainWindow
    if (w === null || w.isDestroyed() || !revealed) return // still on the splash
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  app.whenReady().then(createWindow)
}

// Started by the previous portable version as it quits: it holds the single-instance
// lock until it has exited, which is also when its exe can be deleted.
const previousExe = previousFromArgv(process.argv)
const portableExe = process.env.PORTABLE_EXECUTABLE_FILE
if (previousExe !== null && portableExe !== undefined && isDeletablePrevious(previousExe, portableExe)) {
  void removePrevious(previousExe).finally(start)
} else {
  start()
}
app.on('window-all-closed', () => {
  // Fix 3: tear the engine down (pool/bridge/watchers) before quitting --
  // not just on the window's own 'closed' event above, which covers the
  // single-window-open path this app has today but not every quit path
  // (e.g. a future multi-window flow, or the app quitting via another
  // route that never fires 'closed' first).
  engine?.dispose()
  if (process.platform !== 'darwin') app.quit()
})
// Belt-and-suspenders teardown for quit paths that bypass window-all-closed
// entirely (e.g. Cmd+Q on macOS while windows are still open, or the OS
// terminating the app). Both handlers -- and win.on('closed') above --
// converge on the same idempotent dispose(), so no ordering between them
// matters.
app.on('before-quit', () => { quitting = true; engine?.dispose() })
app.on('will-quit', () => { engine?.dispose() })
