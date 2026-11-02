import type { SessionSummary } from '../../shared/types'
import { RemoteBadge } from './RemoteBadge'

export function Blade({ sessions, selectedId, remote = new Set<number>(), collapsed, width, onToggle, onSelect }: {
  sessions: SessionSummary[]
  /** Session ids under Remote Control (/rc). */
  remote?: Set<number>
  selectedId: number | null
  collapsed: boolean
  width: number
  onToggle: () => void
  onSelect: (session: SessionSummary) => void
}) {
  return (
    <aside className={collapsed ? 'blade collapsed' : 'blade'} aria-label="Sessions"
      style={collapsed ? undefined : { width }}>
      <button className="blade-toggle" onClick={onToggle}
        aria-expanded={!collapsed} title={collapsed ? 'Show sessions' : 'Hide sessions'}>
        {collapsed ? '▶' : `◀  SESSIONS — ${sessions.length}`}
      </button>
      {!collapsed && sessions.length === 0 && <div className="empty">No sessions in this channel.</div>}
      {!collapsed && sessions.map(s => (
        <div key={s.id} className="sess" role="option" tabIndex={0}
          aria-selected={s.id === selectedId}
          onClick={() => onSelect(s)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s) } }}>
          <div className="sess-t">{remote.has(s.id) && <RemoteBadge className="rc-badge-inline" />}{s.title ?? `Untitled · ${s.sessionId.slice(0, 8)}`}</div>
          <div className="sess-m">
            <span>{s.lastTs?.slice(0, 10) ?? '—'}</span>
            <span>{s.messageCount} msg</span>
          </div>
        </div>
      ))}
    </aside>
  )
}
