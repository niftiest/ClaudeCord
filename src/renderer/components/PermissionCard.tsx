import { useState } from 'react'
import type { PermissionRequest } from '../../shared/engine-types'
import { summarizePermissionRequest, previewAllowAlwaysRule, parseEditedInput } from '../lib'

type Decision = 'allow' | 'allow_always' | 'deny'

/** Inline card for an ordinary tool-permission request (Plan 2 Task 9),
 *  rendered by Transcript below the messages whenever the running `claude`
 *  CLI is blocked on a decision. Visually matches ToolCard's monospace/dark
 *  card look but adds an amber "permission requested" header plus the
 *  Allow / Allow-always / Deny / Edit controls.
 *
 *  A request is answered once: after any decision, `resolved` locks in and
 *  every button is disabled (belt-and-braces -- PermissionBridge itself
 *  already no-ops a second `resolve()` for the same id, but the UI must not
 *  invite a confusing double-click either). `onResolve` is a plain callback
 *  (not a direct `api.resolvePermission` call) so this component stays free
 *  of any IPC/electron import, same as every other renderer component here --
 *  the parent (Transcript/App) owns the actual IPC call and pending-list
 *  bookkeeping. */
export function PermissionCard({ req, onResolve }: {
  req: PermissionRequest
  onResolve: (id: string, decision: Decision, editedInput?: unknown, denyMessage?: string) => void
}) {
  const [resolved, setResolved] = useState<'allow' | 'deny' | null>(null)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(() => JSON.stringify(req.input, null, 2) ?? '')
  const [editError, setEditError] = useState<string | null>(null)

  const disabled = resolved !== null
  const inputJson = JSON.stringify(req.input, null, 2) ?? ''
  const rulePreview = previewAllowAlwaysRule(req.tool, req.input)

  function resolve(decision: Decision, editedInput?: unknown, denyMessage?: string) {
    if (disabled) return // already answered -- one decision per request
    setResolved(decision === 'deny' ? 'deny' : 'allow')
    setEditing(false)
    onResolve(req.id, decision, editedInput, denyMessage)
  }

  function submitEdit() {
    if (disabled) return
    const parsed = parseEditedInput(editText)
    if (!parsed.ok) {
      setEditError(parsed.error)
      return
    }
    setEditError(null)
    resolve('allow', parsed.value)
  }

  return (
    <div className="perm-card">
      <div className="perm-head">
        <span className="perm-badge">⚠ Permission requested</span>
        <span className="perm-summary">{summarizePermissionRequest(req.tool, req.input)}</span>
      </div>
      <pre className="perm-input">{inputJson.slice(0, 8000)}</pre>

      {editing && !disabled && (
        <div className="perm-edit">
          <textarea
            className="perm-edit-input"
            rows={6}
            value={editText}
            onChange={e => { setEditText(e.target.value); setEditError(null) }}
          />
          {editError !== null && <div className="perm-edit-error">Invalid JSON: {editError}</div>}
        </div>
      )}

      <div className="perm-actions">
        <button type="button" className="btn-primary" disabled={disabled} onClick={() => resolve('allow')}>
          Allow
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={disabled}
          title={`Will persist: ${rulePreview}`}
          onClick={() => resolve('allow_always')}
        >
          Allow always <span className="perm-rule">{rulePreview}</span>
        </button>
        <button
          type="button"
          className="btn-secondary perm-deny"
          disabled={disabled}
          onClick={() => resolve('deny', undefined, 'Denied by user')}
        >
          Deny
        </button>
        {editing
          ? <button type="button" className="btn-primary" disabled={disabled} onClick={submitEdit}>Allow with edit</button>
          : <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setEditing(true)}>Edit</button>}
      </div>

      {disabled && <div className="perm-resolved">{resolved === 'allow' ? 'Allowed' : 'Denied'}</div>}
    </div>
  )
}
