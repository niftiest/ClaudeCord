import { BrowserWindow } from 'electron'
import type { IndexProgress } from '../shared/types'

/** Small square launch window, shown the instant the app starts while the real
 *  window loads hidden behind it. The app's asterisk turns over above one
 *  status line and a progress bar. Self-contained HTML (data:
 *  URL, no preload, no node) -- status is pushed in with executeJavaScript,
 *  which is safe here because every value is JSON-encoded, never spliced in raw. */

const SIZE = 264
const RADIUS = 32

/** The app's asterisk, as in the icon but without its tile. */
const MARK = `<line x1="50" y1="14" x2="50" y2="86"/><line x1="14" y1="50" x2="86" y2="50"/>
  <line x1="24.5" y1="24.5" x2="75.5" y2="75.5"/><line x1="75.5" y1="24.5" x2="24.5" y2="75.5"/>`

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;-webkit-app-region:drag;
    font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
  .tile{box-sizing:border-box;width:${SIZE}px;height:${SIZE}px;border-radius:${RADIUS}px;background:#16171b;
    border:2px solid #2a2c33;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .mark line{stroke:#fff;stroke-width:9.5;stroke-linecap:round}
  .mark{animation:turn 1.5s cubic-bezier(.65,0,.35,1) infinite}
  @keyframes turn{0%{transform:rotate(0)}70%,100%{transform:rotate(45deg)}}
  #status{margin-top:24px;max-width:240px;font-size:13.5px;font-weight:600;color:#f2f3f5;text-align:center;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar{margin-top:12px;width:150px;height:8px;border-radius:4px;background:#2a2c33;overflow:hidden}
  .bar i{display:block;height:100%;width:0;border-radius:4px;background:#5865f2;transition:width .2s ease}
  .bar.indet i{width:35%;animation:slide 1.1s ease-in-out infinite}
  @keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
</style></head><body><div class="tile">
  <svg class="mark" viewBox="0 0 100 100" width="76" height="76" aria-hidden="true">${MARK}</svg>
  <div id="status">Starting up…</div>
  <div class="bar indet" id="bar"><i id="fill"></i></div>
</div><script>
  window.setStatus = function (text, pct) {
    document.getElementById('status').textContent = text;
    var bar = document.getElementById('bar'), fill = document.getElementById('fill');
    if (typeof pct === 'number') { bar.classList.remove('indet'); fill.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
    else { bar.classList.add('indet'); fill.style.width = ''; }
  };
</script></body></html>`

export type Splash = {
  /** Status line + optional 0-100 progress (omit for an indeterminate bar). */
  setStatus(text: string, pct?: number): void
  /** Maps catalog-index progress onto the splash. */
  showIndexProgress(p: IndexProgress): void
  close(): void
}

export function createSplash(icon?: string): Splash {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    frame: false,
    transparent: true, // the rounded corners are drawn by the page
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    center: true,
    backgroundColor: '#00000000',
    title: 'ClaudeCord',
    ...(icon !== undefined ? { icon } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show() })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`)

  let ready = false
  let pending: [string, number | undefined] | null = null
  win.webContents.once('did-finish-load', () => {
    ready = true
    if (pending !== null) push(pending[0], pending[1])
  })

  // Index progress can fire hundreds of times a second; the splash only
  // needs a few repaints. Throttle to ~10/s, always keeping the latest value.
  let lastPushAt = 0
  function push(text: string, pct?: number): void {
    if (win.isDestroyed()) return
    if (!ready) { pending = [text, pct]; return }
    lastPushAt = Date.now()
    void win.webContents
      .executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${pct === undefined ? 'undefined' : JSON.stringify(pct)})`)
      .catch(() => { /* window closing */ })
  }

  return {
    setStatus: (text, pct) => push(text, pct),
    showIndexProgress(p) {
      if (Date.now() - lastPushAt < 100 && p.done < p.total) return
      const pct = p.bytesTotal === 0 ? 0 : (p.bytesDone / p.bytesTotal) * 100
      push(`Reading chats ${p.done.toLocaleString()} of ${p.total.toLocaleString()}…`, pct)
    },
    close() {
      if (!win.isDestroyed()) win.close()
    }
  }
}
