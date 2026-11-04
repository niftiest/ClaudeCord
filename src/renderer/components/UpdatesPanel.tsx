import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { describeRestartWait, nothingToInterrupt, type RestartWork, type UpdateStatus } from '../../shared/update-types'

/** Plain-language line for an update status. */
export function describeUpdate(s: UpdateStatus, autoInstall = false): string {
  switch (s.state) {
    case 'idle': return 'Not checked yet.'
    case 'checking': return 'Checking for updates…'
    case 'none': return 'You have the latest version.'
    case 'available': return `Version ${s.version} is available, but it couldn't be downloaded automatically${s.reason !== undefined ? `: ${s.reason}` : '.'}`
    case 'downloading': return `Downloading version ${s.version}… ${s.percent}%`
    case 'ready': return autoInstall
      ? `Version ${s.version} is ready. It installs the next time ClaudeCord is idle, or restart now.`
      : `Version ${s.version} is ready. Restart ClaudeCord to install it.`
    case 'error': return `Couldn't check for updates: ${s.message}`
    case 'unsupported': return s.reason
  }
}

/** "Restart to update": straight away if that interrupts nothing, otherwise it asks. */
function useRestartRequest(): { request: () => void; dialog: ReactNode } {
  const [work, setWork] = useState<RestartWork | null>(null)
  const open = work !== null
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { void api.updateRestartWork().then(setWork).catch(() => {}) }, 2000)
    return () => clearInterval(timer)
  }, [open])
  const request = (): void => {
    void api.updateRestartWork().then(w => {
      if (nothingToInterrupt(w)) void api.installUpdate()
      else setWork(w)
    })
  }
  return { request, dialog: work === null ? null : <RestartDialog work={work} onClose={() => setWork(null)} /> }
}

function RestartDialog({ work, onClose }: { work: RestartWork; onClose: () => void }) {
  const clear = nothingToInterrupt(work)
  const working = work.chats.length > 0
  return createPortal(
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Restart to update">
      <div className="modal restart-dialog">
        <h2 className="modal-title">{clear ? 'Nothing is running now' : working ? 'Claude is still working' : 'You have an unsent message'}</h2>
        {working && (
          <ul className="restart-chats">
            {work.chats.map((title, i) => <li key={i}>{title}</li>)}
          </ul>
        )}
        {working && <p className="settings-note">Restarting now stops {work.chats.length === 1 ? 'this chat' : 'these chats'}. What’s saved so far stays, but you’d have to tell Claude to carry on. A command already running can keep going after the restart with nothing watching it, so it may still change files.</p>}
        {work.unsent && <p className="settings-note">A message you’ve typed, queued or attached hasn’t been sent. Restarting now loses it.</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          {clear
            ? <button type="button" className="btn-primary" onClick={() => { onClose(); void api.installUpdate() }}>Restart now</button>
            : <>
                <button type="button" className="btn-secondary" onClick={() => { onClose(); void api.installUpdate() }}>Restart now</button>
                <button type="button" className="btn-primary" autoFocus onClick={() => { onClose(); void api.restartWhenFinished() }}>Restart when finished</button>
              </>}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Live update status (subscribes to main's broadcasts). */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void api.getUpdateStatus().then(setStatus).catch(() => {})
    return api.onUpdateStatus(setStatus)
  }, [])
  return status
}

/** Settings > Updates: current version, status, and the actions that apply. */
export function UpdatesPanel({ autoInstall }: { autoInstall: boolean }) {
  const status = useUpdateStatus()
  const restart = useRestartRequest()
  if (status === null) return null
  const busy = status.state === 'checking' || status.state === 'downloading'
  return (
    <div className="updates-panel">
      <div className="settings-row">
        <div className="settings-row-label">ClaudeCord {status.currentVersion}
          <span className="settings-hint">
            {status.channel === 'portable' ? 'Portable version: a new version downloads beside this file, starts, and removes the old one.' : status.channel === 'dev' ? 'Development build.' : 'Installed version: updates download and install automatically.'}
          </span>
        </div>
      </div>
      <p className={`updates-status updates-${status.state}`}>{status.restartWaiting !== null ? `${describeRestartWait(status.restartWaiting)}.` : describeUpdate(status, autoInstall)}</p>
      <div className="updates-actions">
        {status.channel !== 'dev' && status.state !== 'ready' && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void api.checkForUpdates()}>
            {status.state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {status.state === 'ready' && status.restartWaiting === null && (
          <button type="button" className="btn-primary" onClick={restart.request}>Restart to update</button>
        )}
        {status.state === 'ready' && status.restartWaiting !== null && (
          <>
            <button type="button" className="btn-secondary" onClick={() => void api.cancelUpdateRestart()}>Don’t restart</button>
            <button type="button" className="btn-primary" onClick={() => void api.installUpdate()}>Restart now</button>
          </>
        )}
        {status.state === 'available' && status.channel === 'portable' && (
          <button type="button" className="btn-primary" onClick={() => void api.openUpdateDownload()}>Download</button>
        )}
      </div>
      {restart.dialog}
    </div>
  )
}

/** Slim bar across the top of the app when an update is ready to install, when a
 *  portable build couldn't fetch one itself, or just after a portable update. */
export function UpdateBar() {
  const status = useUpdateStatus()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const restart = useRestartRequest()
  if (status === null) return null
  const ready = status.state === 'ready'
  const portableAvailable = status.state === 'available' && status.channel === 'portable'
  if (!ready && !portableAvailable) {
    if (!status.justUpdated || dismissed === status.currentVersion) return null
    return (
      <div className="update-bar" role="status">
        <span>Updated to ClaudeCord {status.currentVersion}.</span>
        <button type="button" className="update-bar-x" aria-label="Dismiss" onClick={() => setDismissed(status.currentVersion)}>✕</button>
      </div>
    )
  }
  const version = status.state === 'ready' || status.state === 'available' ? status.version : ''
  if (ready && status.restartWaiting !== null) {
    return (
      <div className="update-bar" role="status">
        <span>ClaudeCord {version}: {describeRestartWait(status.restartWaiting).toLowerCase()}.</span>
        <button type="button" className="update-bar-btn" onClick={() => void api.installUpdate()}>Restart now</button>
        <button type="button" className="update-bar-btn update-bar-btn-next" onClick={() => void api.cancelUpdateRestart()}>Don’t restart</button>
      </div>
    )
  }
  if (dismissed === version) return null
  return (
    <div className="update-bar" role="status">
      <span>ClaudeCord {version} is {ready ? 'ready to install' : 'available'}.</span>
      {ready
        ? <button type="button" className="update-bar-btn" onClick={restart.request}>Restart to update</button>
        : <button type="button" className="update-bar-btn" onClick={() => void api.openUpdateDownload()}>Download</button>}
      <button type="button" className="update-bar-x" aria-label="Dismiss" title="Later" onClick={() => setDismissed(version)}>✕</button>
      {restart.dialog}
    </div>
  )
}
