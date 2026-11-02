import type { ContextUsage } from '../../shared/project-options'
import type { SessionSummary } from '../../shared/types'
import type { FsEntry } from '../../shared/ipc'
import { costOfSession, formatCost } from '../../shared/models'

/** Compact token count: 412000 -> "412k", 2_100_000 -> "2.1M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** 300px right context rail: a single panel -- the project file tree (bounded,
 *  with git status) on top, and the session's token usage + estimated list
 *  price pinned at the bottom. Read-only. Collapses to the 46px strip. */
/** Claude compacts by itself near the limit; this is the point to think about it. */
const CONTEXT_WARN_PERCENT = 80

export function ContextRail({ session, fsEntries, hasKey, canCreateImage, onCreateImage, onCollapse, context = null, onCompact }: {
  /** How full the chat is, while it has a process running. */
  context?: ContextUsage | null
  /** Offered once the chat is getting full; undefined while it can't be done. */
  onCompact?: () => void
  session: SessionSummary | null
  fsEntries: FsEntry[]
  /** OpenRouter key is set -- enables the Create-Image tool. */
  hasKey: boolean
  /** There's a real working directory to save into. */
  canCreateImage: boolean
  onCreateImage: () => void
  onCollapse: () => void
}) {
  const tokens = {
    inputTokens: session?.inputTokens ?? 0,
    outputTokens: session?.outputTokens ?? 0,
    cacheRead: session?.cacheRead ?? 0,
    cacheWrite: session?.cacheWrite ?? 0
  }
  const cost = session ? costOfSession(session.model, tokens) : 0

  return (
    <aside className="crail" aria-label="Files & usage">
      <div className="crail-head">
        <button type="button" className="crail-collapse" title="Collapse rail" aria-label="Collapse context rail"
          onClick={onCollapse}>»</button>
        <span className="crail-title">Files</span>
        <button type="button" className="crail-add" disabled={!hasKey || !canCreateImage}
          title={!hasKey ? 'Set an OpenRouter key in Settings to generate images'
            : !canCreateImage ? 'Open a chat with a working directory first'
            : 'Create image with AI'}
          aria-label="Create image with AI" onClick={onCreateImage}>＋</button>
      </div>

      <div className="crail-body">
        {fsEntries.length === 0
          ? <p className="settings-note" style={{ padding: '8px 10px' }}>No files{session ? '' : ' — open a chat'} to show.</p>
          : <div className="crail-tree">
              {fsEntries.map(e => (
                <div key={e.relPath} className="crail-file" title={e.relPath} style={{ paddingLeft: 8 + e.depth * 14 }}>
                  {e.isDir
                    ? <span className="crail-file-dir">▸ {e.name}</span>
                    : <>
                        {e.git && <span className={`crail-git crail-git-${e.git === '?' ? 'new' : 'mod'}`}>{e.git}</span>}
                        <span>{e.name}</span>
                      </>}
                </div>
              ))}
            </div>}
      </div>

      <div className="crail-foot">
        {context !== null && (
          <div className={`crail-context${context.percent >= CONTEXT_WARN_PERCENT ? ' crail-context-full' : ''}`}
            title={context.categories.map(c => `${c.name}: ${fmtTokens(c.tokens)}`).join('\n')}>
            <div className="crail-context-head">
              <span className="crail-usage-title">Context</span>
              <span>{Math.round(context.percent)}% · {fmtTokens(context.usedTokens)} / {fmtTokens(context.maxTokens)}</span>
            </div>
            <div className="crail-context-bar"><i style={{ width: `${context.percent}%` }} /></div>
            {context.percent >= CONTEXT_WARN_PERCENT && onCompact !== undefined && (
              <button type="button" className="btn-secondary" onClick={onCompact}>Compact now</button>
            )}
          </div>
        )}
        <div className="crail-usage-title">Session usage</div>
        <div className="crail-tilegrid">
          <div className="crail-tile"><div className="crail-tile-k">input</div><div className="crail-tile-v">{fmtTokens(tokens.inputTokens)}</div></div>
          <div className="crail-tile"><div className="crail-tile-k">output</div><div className="crail-tile-v">{fmtTokens(tokens.outputTokens)}</div></div>
          <div className="crail-tile"><div className="crail-tile-k">cache read</div><div className="crail-tile-v">{fmtTokens(tokens.cacheRead)}</div></div>
          <div className="crail-tile"><div className="crail-tile-k">cache write</div><div className="crail-tile-v">{fmtTokens(tokens.cacheWrite)}</div></div>
        </div>
        <div className="crail-price-row">
          <span>Est. list price</span>
          <span className="crail-price">{formatCost(cost)}</span>
        </div>
      </div>
    </aside>
  )
}

/** 46px collapsed strip: expand button, a Files icon, and an amber dot when the
 *  project has uncommitted changes. */
export function ContextRailStrip({ fsEntries, onExpand }: {
  fsEntries: FsEntry[]
  onExpand: () => void
}) {
  const dirty = fsEntries.some(e => e.git)
  return (
    <aside className="crail-collapsed" aria-label="Files & usage (collapsed)">
      <button type="button" className="crail-strip-expand" title="Expand rail" aria-label="Expand context rail"
        onClick={onExpand}>«</button>
      <div className="crail-strip-div" />
      <button type="button" className="crail-strip-icon active" title="Files" aria-label="Files" onClick={onExpand}>🗀</button>
      {dirty && <span className="crail-strip-dot" title="Uncommitted changes" aria-hidden="true" style={{ marginTop: 'auto' }} />}
    </aside>
  )
}
