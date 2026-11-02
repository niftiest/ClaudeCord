import { useEffect, useState } from 'react'
import { api } from '../api'
import type { UpdateStatus } from '../../shared/update-types'

/** Plain-language line for an update status. */
export function describeUpdate(s: UpdateStatus): string {
  switch (s.state) {
    case 'idle': return 'Not checked yet.'
    case 'checking': return 'Checking for updates…'
    case 'none': return 'You have the latest version.'
    case 'available': return `Version ${s.version} is available, but it couldn't be downloaded automatically${s.reason !== undefined ? `: ${s.reason}` : '.'}`
    case 'downloading': return `Downloading version ${s.version}… ${s.percent}%`
    case 'ready': return `Version ${s.version} is ready. It installs the next time ClaudeCord is idle, or restart now.`
    case 'error': return `Couldn't check for updates: ${s.message}`
    case 'unsupported': return s.reason
  }
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
export function UpdatesPanel() {
  const status = useUpdateStatus()
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
      <p className={`updates-status updates-${status.state}`}>{describeUpdate(status)}</p>
      <div className="updates-actions">
        {status.channel !== 'dev' && status.state !== 'ready' && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void api.checkForUpdates()}>
            {status.state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {status.state === 'ready' && (
          <button type="button" className="btn-primary" onClick={() => void api.installUpdate()}>Restart to update</button>
        )}
        {status.state === 'available' && status.channel === 'portable' && (
          <button type="button" className="btn-primary" onClick={() => void api.openUpdateDownload()}>Download</button>
        )}
      </div>
    </div>
  )
}

/** Slim bar across the top of the app when an update is ready to install, when a
 *  portable build couldn't fetch one itself, or just after a portable update. */
export function UpdateBar() {
  const status = useUpdateStatus()
  const [dismissed, setDismissed] = useState<string | null>(null)
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
  if (dismissed === version) return null
  return (
    <div className="update-bar" role="status">
      <span>ClaudeCord {version} is {ready ? 'ready to install' : 'available'}.</span>
      {ready
        ? <button type="button" className="update-bar-btn" onClick={() => void api.installUpdate()}>Restart to update</button>
        : <button type="button" className="update-bar-btn" onClick={() => void api.openUpdateDownload()}>Download</button>}
      <button type="button" className="update-bar-x" aria-label="Dismiss" title="Later" onClick={() => setDismissed(version)}>✕</button>
    </div>
  )
}
