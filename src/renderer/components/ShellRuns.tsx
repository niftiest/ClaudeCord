import { api } from '../api'
import type { ShellRun } from '../../shared/shell-run-types'

/** `!` commands waiting to go to Claude, above the composer. Once the next message
 *  carries them they become part of the transcript and leave this list. */
export function ShellRuns({ runs }: { runs: ShellRun[] }) {
  if (runs.length === 0) return null
  return (
    <div className="shell-runs" aria-label="Shell commands">
      {runs.map(run => (
        <div key={run.id} className={`shell-run shell-run-${run.state}`}>
          <div className="shell-run-head">
            <code className="shell-run-cmd">!{run.command}</code>
            <span className="shell-run-status">{status(run)}</span>
            <span className="shell-run-actions">
              {run.state === 'running' && <button type="button" className="btn-secondary" onClick={() => void api.shellStop(run.id)}>Stop</button>}
              <button type="button" className="btn-secondary" title="Don’t send this to Claude" onClick={() => void api.shellDismiss(run.id)}>Leave out</button>
            </span>
          </div>
          {run.output !== '' && <pre className="shell-run-output">{run.output.trimEnd()}</pre>}
        </div>
      ))}
      <div className="composer-hint">Claude sees these with your next message.</div>
    </div>
  )
}

function status(run: ShellRun): string {
  if (run.state === 'running') return 'Running…'
  if (run.state === 'stopped') return 'Stopped'
  return run.exitCode === null || run.exitCode === 0 ? 'Done' : `Exit code ${run.exitCode}`
}
