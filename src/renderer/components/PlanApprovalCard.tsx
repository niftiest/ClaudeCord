import { useState } from 'react'
import type { PermissionRequest } from '../../shared/engine-types'
import { planTextFromInput } from '../lib'

type Decision = 'allow' | 'deny'

/** Inline card for a plan-mode approval request (Plan 2 Task 9): the CLI
 *  surfaces "review this plan" as a `tool === 'ExitPlanMode'` permission
 *  request (see `isPlanApproval` in lib.ts), which Transcript routes here
 *  instead of to the ordinary PermissionCard. Simpler than PermissionCard on
 *  purpose -- no allow-always rule to persist, no editable JSON input, just
 *  the plan text and an accept/reject choice.
 *
 *  Rejecting sends `'Keep planning'` as the deny message so the CLI/agent
 *  sees why the plan wasn't approved, distinct from the ordinary
 *  "Denied by user" a PermissionCard's Deny button sends. */
export function PlanApprovalCard({ req, onResolve }: {
  req: PermissionRequest
  onResolve: (id: string, decision: Decision, editedInput?: unknown, denyMessage?: string) => void
}) {
  const [resolved, setResolved] = useState<Decision | null>(null)
  const disabled = resolved !== null
  const planText = planTextFromInput(req.input)

  function resolve(decision: Decision) {
    if (disabled) return // already answered -- one decision per request
    setResolved(decision)
    onResolve(req.id, decision, undefined, decision === 'deny' ? 'Keep planning' : undefined)
  }

  return (
    <div className="perm-card plan-card">
      <div className="perm-head">
        <span className="perm-badge">📝 Plan ready for review</span>
      </div>
      <pre className="perm-input">{planText.slice(0, 8000)}</pre>
      <div className="perm-actions">
        <button type="button" className="btn-primary" disabled={disabled} onClick={() => resolve('allow')}>
          Approve &amp; run
        </button>
        <button type="button" className="btn-secondary" disabled={disabled} onClick={() => resolve('deny')}>
          Keep planning / Reject
        </button>
      </div>
      {disabled && <div className="perm-resolved">{resolved === 'allow' ? 'Approved' : 'Rejected'}</div>}
    </div>
  )
}
