import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { RenderItem } from '../../shared/types'
import type { PermissionRequest } from '../../shared/engine-types'
import type { ChannelIcon } from '../../shared/shell-types'
import { ClaudeAvatar } from './ClaudeAvatar'
import { ToolCard } from './ToolCard'
import { ChatImage } from './ChatImage'
import { Markdown } from './Markdown'
import { PermissionCard } from './PermissionCard'
import { PlanApprovalCard } from './PlanApprovalCard'
import { groupToolRuns, toolRunSummary, stableItemKeys, groupIntoTurns, shouldScrollToBottom, isPlanApproval, formatClock, localDayKey, dayDividerLabel, type LivePreview } from '../lib'

type ResolvePermission = (id: string, decision: 'allow' | 'allow_always' | 'deny', editedInput?: unknown, denyMessage?: string) => void

export function Transcript({ pendingToolIds, groupToolCalls = true, items: allItems, hasMore, loadingOlder, loading, onReachTop, permissionRequests, onResolvePermission, livePreview, showToolCalls = true, onAtBottomChange, fileMissing = false, claudeIcon = { kind: 'initials' }, scrollToBottomSignal, thinkingExpanded = false, toolCardsExpanded = false }: {
  items: RenderItem[]
  hasMore: boolean
  loadingOlder: boolean
  /** True while the very first page of this session is still in flight. Lets
   *  us tell "nothing has loaded yet" apart from "this session is genuinely
   *  empty" instead of flashing an incorrect empty state on a slow IPC round trip. */
  loading: boolean
  onReachTop: () => void
  /** Pending permission/plan-approval requests for the open session (Plan 2
   *  Task 9), rendered inline after the messages — they block the turn. */
  permissionRequests?: PermissionRequest[]
  onResolvePermission?: ResolvePermission
  /** Transient "assistant is typing" preview (Plan 2 Task 10) accumulated from
   *  live engine:event deltas, rendered after the messages while a turn streams. */
  livePreview?: LivePreview | null
  /** When false, tool-call cards are dropped from the transcript (Appearance
   *  setting "Show tool calls") -- for readers who only want the conversation. */
  showToolCalls?: boolean
  /** Collapse each run of tool calls and thoughts into one line. */
  groupToolCalls?: boolean
  /** Reports whether the view is pinned near the bottom (following live) vs
   *  scrolled up (reading history). App uses this to skip the disruptive
   *  background-sync reload while the user is reading older messages. */
  onAtBottomChange?: (atBottom: boolean) => void
  /** The session's transcript file was removed from disk (Claude Code's
   *  cleanupPeriodDays) though the catalog still has it -- show an archived
   *  message instead of the misleading "no messages". */
  fileMissing?: boolean
  /** App-wide avatar for Claude's turns (Settings → Appearance). */
  claudeIcon?: ChannelIcon
  /** Changes (any new value) request an imperative jump to the absolute bottom
   *  -- App bumps it when the user sends a message so the view catches up even
   *  if they were scrolled up reading history. */
  scrollToBottomSignal?: number
  /** Thinking blocks / tool cards start open (Settings → Appearance). */
  thinkingExpanded?: boolean
  toolCardsExpanded?: boolean
  /** Tool calls in the running turn still waiting for a result. */
  pendingToolIds?: ReadonlySet<string>
}) {
  const pending = permissionRequests ?? []
  const preview = livePreview ?? null
  // Filter tool cards out here (not upstream) so the durable render model is
  // untouched and toggling the setting re-shows them without a reload.
  const items = useMemo(
    () => (showToolCalls ? allItems : allItems.filter(it => it.kind !== 'tool')),
    [allItems, showToolCalls]
  )
  const parentRef = useRef<HTMLDivElement>(null)
  // Stable React keys so a loadOlder prepend reconciles the existing message
  // DOM in place (no remount), which is what keeps the scroll-preservation
  // below correct. A single message uuid can emit several RenderItems (a text
  // item + a tool item from one turn), so uuid alone isn't unique;
  // stableItemKeys appends a per-uuid run counter that survives a prepend.
  const itemKeys = useMemo(() => stableItemKeys(items), [items])
  // Group the flat list into user/Claude turns so the transcript reads as a
  // back-and-forth; keys still come from itemKeys[startIndex + i] so a
  // loadOlder prepend reconciles in place (scroll preservation below relies on it).
  const turns = useMemo(() => groupIntoTurns(items), [items])

  // Discord-style day dividers: the label to render *before* each turn, or null
  // if that turn is on the same local day as the previous dated turn. Turns with
  // no timestamp (e.g. a tool-only turn) inherit the running day and never force
  // a divider, so a dateless turn between two same-day turns doesn't split them.
  const dividers = useMemo(() => {
    let prevKey: number | null = null
    return turns.map(turn => {
      const first = firstTs(turn.items)
      const key = localDayKey(first)
      if (key === null || key === prevKey) return null
      prevKey = key
      return dayDividerLabel(first)
    })
  }, [turns])

  // Chat scroll behaviour (no virtualization — the paged loader caps the DOM
  // at ~60 messages/page, so a plain flowing column scrolls as one, which is
  // exactly what a chat wants; a virtualizer boxed each message into its own
  // scroll region). This component is remounted (key={session.id} in App) on
  // every session switch, so neither ref carries stale geometry across sessions.
  // "Following at the bottom" (within this margin) vs "reading history". Larger
  // than the loadOlder trigger so a small nudge up doesn't flip us out of
  // follow mode mid-stream.
  const BOTTOM_MARGIN = 80
  const reportAtBottom = (): void => {
    const el = parentRef.current
    if (el === null || onAtBottomChange === undefined) return
    onAtBottomChange(el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_MARGIN)
  }

  const prevHeight = useRef(0)
  const scrolledToBottom = useRef(false)
  // rAF handle for the post-open "settle" re-pin (below). Cancelled on unmount
  // so a pending frame never touches a torn-down element.
  const pinRaf = useRef(0)

  // Re-assert the bottom across the next several frames. The one-shot
  // scrollTop=scrollHeight in a layout effect lands before some content
  // finalizes its height (wrapped text reflow, the day divider, late font
  // metrics), which grows scrollHeight a hair AFTER commit and leaves the view
  // a few px above the true bottom -- the "have to nudge down on open" glitch.
  // Each frame only closes a SMALL residual gap; once the gap is large (a
  // deliberate scroll-up, or live streaming outpacing us) it stops, so it never
  // fights the reader or the streaming-follow effect.
  const settlePinToBottom = (): void => {
    cancelAnimationFrame(pinRaf.current)
    let ticks = 0
    const step = (): void => {
      const el = parentRef.current
      if (el === null) return
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      if (gap >= BOTTOM_MARGIN) return // scrolled away / streaming: leave it be
      if (gap > 0) el.scrollTop = el.scrollHeight
      if (++ticks < 8) pinRaf.current = requestAnimationFrame(step)
    }
    pinRaf.current = requestAnimationFrame(step)
  }
  useEffect(() => () => cancelAnimationFrame(pinRaf.current), [])

  useLayoutEffect(() => {
    const el = parentRef.current
    if (el === null) return
    if (shouldScrollToBottom(scrolledToBottom.current, items.length)) {
      // First non-empty render of this session: land on the newest message,
      // then keep it pinned for a few frames while variable-height content
      // settles so we reliably end up exactly at the bottom.
      el.scrollTop = el.scrollHeight
      scrolledToBottom.current = true
      settlePinToBottom()
    } else if (prevHeight.current > 0 && el.scrollHeight > prevHeight.current) {
      // A later growth is a loadOlder prepend: keep the reading position by
      // pushing scrollTop down by exactly the height the prepend added.
      el.scrollTop += el.scrollHeight - prevHeight.current
    }
    prevHeight.current = el.scrollHeight
    reportAtBottom()
  }, [items])

  // If a page renders shorter than the viewport, the container never becomes
  // scrollable and the user can't scroll-to-top to pull the next page — so
  // pull it proactively until content fills the viewport or hasMore is false.
  useLayoutEffect(() => {
    const el = parentRef.current
    if (el === null || loadingOlder || !hasMore) return
    if (el.scrollHeight <= el.clientHeight) onReachTop()
  }, [items, hasMore, loadingOlder, onReachTop])

  function handleScroll() {
    reportAtBottom()
    const el = parentRef.current
    if (el === null || loadingOlder || !hasMore) return
    if (el.scrollTop < 240) onReachTop()
  }

  // Follow the live preview to the bottom as it streams in.
  useLayoutEffect(() => {
    const el = parentRef.current
    if (el === null || preview === null) return
    el.scrollTop = el.scrollHeight
  }, [preview])

  // Imperative jump to the absolute bottom on demand (App bumps the signal when
  // the user sends). Re-arms follow so the just-sent turn — which lands a beat
  // later via the live stream — appends pinned to the bottom rather than off
  // screen. Skips the initial mount (the first-render effect already lands at
  // the bottom) so it never fights scroll restoration on a session switch.
  const didMountScroll = useRef(false)
  useLayoutEffect(() => {
    if (!didMountScroll.current) { didMountScroll.current = true; return }
    const el = parentRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    reportAtBottom()
  }, [scrollToBottomSignal])

  if (items.length === 0 && pending.length === 0 && preview === null) {
    if (fileMissing) {
      return (
        <div className="empty transcript-archived">
          <div className="transcript-archived-title">Transcript no longer on disk</div>
          <p>Claude Code deletes chat transcripts older than its <code>cleanupPeriodDays</code> (30 days by
            default), so this conversation’s file is gone. Its cost and metadata are still recorded here.</p>
          <p>To keep future transcripts longer, raise <code>cleanupPeriodDays</code> in your Claude Code settings.</p>
        </div>
      )
    }
    return <div className="empty" style={{ flex: 1 }}>{loading ? 'Loading…' : 'No messages in this session.'}</div>
  }

  return (
    <div className="stream" ref={parentRef} onScroll={handleScroll}>
      {hasMore && <div className="empty">{loadingOlder ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}</div>}
      {turns.map((turn, ti) => {
        const keyAt = (li: number): string => itemKeys[turn.startIndex + li]!
        const ts = formatClock(firstTs(turn.items))
        const divider = dividers[ti]
        const dayDivider = divider !== null && divider !== undefined
          ? <div key={`day:${keyAt(0)}`} className="day-divider"><span>{divider}</span></div>
          : null

        if (turn.role === 'notice') {
          return (
            <Fragment key={keyAt(0)}>
              {dayDivider}
              <div className="turn-notice">
                {turn.items.map((it, li) => (
                  it.kind === 'notice'
                    ? <details key={keyAt(li)} className="notice-card">
                        <summary className="notice-summary">
                          <span className="notice-badge" aria-hidden="true">⚙</span>
                          <span className="notice-headline">{it.label ?? noticeHeadline(it.text)}</span>
                          {ts && <time className="notice-time">{ts}</time>}
                        </summary>
                        <pre className="notice-body">{it.text}</pre>
                      </details>
                    : null
                ))}
              </div>
            </Fragment>
          )
        }

        if (turn.role === 'user') {
          return (
            <Fragment key={keyAt(0)}>
              {dayDivider}
              <div className="turn-user">
                <div className="turn-user-col">
                  <div className="turn-meta">
                    {ts && <time className="turn-time">{ts}</time>}
                    <span className="turn-author">You</span>
                  </div>
                  {turn.items.map((it, li) => (
                    it.kind === 'text'
                      ? <div key={keyAt(li)} className="bubble-me txt">{it.text}</div>
                      : it.kind === 'image'
                        ? <ChatImage key={keyAt(li)} source={it.source} />
                        : null
                  ))}
                </div>
              </div>
            </Fragment>
          )
        }

        const model = modelOf(turn)
        return (
          <Fragment key={keyAt(0)}>
            {dayDivider}
            <div className="turn">
              <ClaudeAvatar icon={claudeIcon} size={28} />
              <div className="turn-body">
                <div className="turn-meta">
                  <span className="turn-author claude">Claude</span>
                  {ts && <time className="turn-time">{ts}</time>}
                  {model && <span className="turn-model">{model}</span>}
                </div>
                {(() => {
                  const renderItem = (it: RenderItem, k: string): ReactNode => {
                    if (it.kind === 'text') return it.literal === true
                      ? <pre key={k} className="bubble-claude shell-output">{it.text}</pre>
                      : <Markdown key={k} text={it.text} className="bubble-claude" />
                    if (it.kind === 'thinking') return (
                      <details key={k} className="turn-thinking" open={thinkingExpanded || undefined}>
                        <summary className="thinking">✳ thought · {it.text.length} chars</summary>
                        <div className="txt think-body">{it.text}</div>
                      </details>
                    )
                    if (it.kind === 'tool') return <ToolCard key={k} item={it} defaultOpen={toolCardsExpanded} pending={pendingToolIds?.has(it.toolUseId) ?? false} />
                    if (it.kind === 'image') return <ChatImage key={k} source={it.source} />
                    return null
                  }
                  if (!groupToolCalls) return turn.items.map((it, li) => renderItem(it, keyAt(li)))
                  return groupToolRuns(turn.items).map(part => {
                    if (!part.group) return renderItem(turn.items[part.index]!, keyAt(part.index))
                    const run = part.indices.map(i => turn.items[i]!)
                    return (
                      <details key={keyAt(part.indices[0]!)} className="tool-run" open={toolCardsExpanded || undefined}>
                        <summary className="tool-run-summary">{toolRunSummary(run)}</summary>
                        <div className="tool-run-body">{part.indices.map(i => renderItem(turn.items[i]!, keyAt(i)))}</div>
                      </details>
                    )
                  })
                })()}
              </div>
            </div>
          </Fragment>
        )
      })}
      {preview !== null && (
        <div className="turn">
          <ClaudeAvatar icon={claudeIcon} size={28} />
          <div className="turn-body">
            <div className="turn-meta">
              <span className="turn-author claude">Claude</span>
              <span className="live-typing-dot" aria-hidden="true">●</span>
              <span className="turn-typing">typing</span>
            </div>
            <div className="bubble-claude streaming"><Markdown text={preview.text} highlight={false} /><span className="stream-caret" aria-hidden="true">▍</span></div>
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <div className="turn">
          <ClaudeAvatar icon={claudeIcon} size={28} />
          <div className="turn-body perm-stack">
            {pending.map(req => (
              isPlanApproval(req.tool)
                ? <PlanApprovalCard key={req.id} req={req}
                    onResolve={(id, decision, editedInput, denyMessage) => onResolvePermission?.(id, decision, editedInput, denyMessage)} />
                : <PermissionCard key={req.id} req={req}
                    onResolve={(id, decision, editedInput, denyMessage) => onResolvePermission?.(id, decision, editedInput, denyMessage)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** A one-line label for a collapsed background-task notice: the wrapper's
 *  <summary> if it has one, otherwise a generic fallback. */
function noticeHeadline(text: string): string {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text)
  const summary = m?.[1]?.trim()
  return summary && summary.length > 0 ? summary : 'Background task update'
}

/** First timestamp in a turn: text/thinking/notice items carry `ts`; tool/image don't. */
function firstTs(items: RenderItem[]): string | null {
  for (const it of items) if ((it.kind === 'text' || it.kind === 'thinking' || it.kind === 'notice') && it.ts) return it.ts
  return null
}

/** The model recorded on a Claude turn's first text item, if any (shown mono in
 *  the meta line). Effort isn't in the durable render model, so it's omitted. */
function modelOf(turn: { items: RenderItem[] }): string | null {
  for (const it of turn.items) if (it.kind === 'text' && it.model) return it.model
  return null
}
