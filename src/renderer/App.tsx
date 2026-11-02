import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { ChannelRow, SessionSummary, RenderItem } from '../shared/types'
import type { IndexProgress as Progress } from '../shared/ipc'
import type { BackgroundTask, PermissionRequest, ExternalLock, RemoteSession } from '../shared/engine-types'
import type { ChannelMeta, ChannelIcon, ChannelGroup, AppSettings } from '../shared/shell-types'
import { Nav } from './components/Nav'
import { IconRail } from './components/IconRail'
import { ContextRail, ContextRailStrip } from './components/ContextRail'
import { CreateImageDialog } from './components/CreateImageDialog'
import { Blade } from './components/Blade'
import { Resizer } from './components/Resizer'
import { Transcript } from './components/Transcript'
import { IndexProgress } from './components/IndexProgress'
import { Composer } from './components/Composer'
import { NewChatDialog } from './components/NewChatDialog'
import { LiveIndicator } from './components/LiveIndicator'
import { ChatHeaderControls } from './components/ChatHeaderControls'
import { SearchOverlay } from './components/SearchOverlay'
import { SettingsWindow, type SettingsSection } from './components/SettingsWindow'
import { BlockedBanner } from './components/BlockedBanner'
import { RemoteBadge } from './components/RemoteBadge'
import { DeleteWizard } from './components/DeleteWizard'
import { UpdateBar } from './components/UpdatesPanel'
import { RetentionNotice } from './components/RetentionNotice'
import { ManageView } from './components/manage/ManageView'
import type { DeleteTarget } from '../shared/manage-types'
import { EnginePool } from './components/EnginePool'
import { McpChip } from './components/McpChip'
import { MemoryDialog } from './components/MemoryDialog'
import { ProjectOptions } from './components/ProjectOptions'
import { effectiveToolDisplay, type ProjectSettings, type ContextUsage } from '../shared/project-options'
import { ShellRuns } from './components/ShellRuns'
import { WorkingLine, BackgroundTasksLine } from './components/WorkingLine'
import type { ShellRun } from '../shared/shell-run-types'
import type { McpServerStatus } from '../shared/claude-info-types'
import { applyTheme, cachedTheme, chatPaneTheme, type ThemeChoice } from './theme'
import {
  resolveChannelName, isStaleResponse, clamp, buildOutgoingText, terminalOnlyCommand, isClearCommand, reduceLivePreview, appendRowsToItems,
  renderItemsFromStreamedRows, applyStreamedToolResults, pendingTools, shouldApplyReload, clearsRunning, hasAssistantRenderItem, suppressSealedPreview,
  firstBlockedElsewhere, projectDirFromSessionKey,
  type ComposerImage, type PastedTextChip, type NewProjectOptions, type LivePreview
} from './lib'

const NAV_MIN = 220, NAV_MAX = 560, BLADE_MIN = 160, BLADE_MAX = 480

function readStoredWidth(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(`cc.width.${key}`)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Boolean UI prefs (sidebar/rail collapse) persist in localStorage, same as
 *  panel widths -- window-local chrome state, no need to round-trip the DB. */
function readStoredBool(key: string, fallback: boolean): boolean {
  const raw = window.localStorage.getItem(`cc.ui.${key}`)
  return raw === null ? fallback : raw === '1'
}

export function App() {
  const [githubReady, setGithubReady] = useState(false)
  useEffect(() => { void api.githubStatus().then(s => setGithubReady(s.state === 'ready')) }, [])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [groups, setGroups] = useState<ChannelGroup[]>([])
  const [project, setProject] = useState<ChannelRow | null>(null)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [memoryChannel, setMemoryChannel] = useState<ChannelRow | null>(null)
  const [turnStartedAt, setTurnStartedAt] = useState(0)
  const [turnTokens, setTurnTokens] = useState(0)
  const [lastEventAt, setLastEventAt] = useState(0)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [liveModel, setLiveModel] = useState<string | null>(null)
  const [context, setContext] = useState<ContextUsage | null>(null)
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>({})
  const [shellRuns, setShellRuns] = useState<ShellRun[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerStatus[] | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [session, setSession] = useState<SessionSummary | null>(null)
  const [items, setItems] = useState<RenderItem[]>([])
  const [oldestSeq, setOldestSeq] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)
  // True when the open session's JSONL was removed from disk (Claude Code's
  // cleanupPeriodDays) but the catalog still has it -- drives an "archived"
  // transcript message instead of "no messages".
  const [transcriptFileMissing, setTranscriptFileMissing] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  const [poolOpen, setPoolOpen] = useState(false)
  const [activeChats, setActiveChats] = useState(0)
  // App-wide settings, loaded once and kept live via SettingsWindow's
  // onSettingsChanged. Null until the first load resolves; the few things that
  // read it (e.g. showToolCalls in the transcript) fall back to sensible
  // defaults while null so nothing flickers on first paint.
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // Channel ids with new activity the user hasn't looked at yet -- drives the
  // nav's unread glow. A channel is marked when a background catalog sync
  // advances its lastActivity while it ISN'T the open project, and cleared the
  // moment the user opens it (openProject).
  const [unread, setUnread] = useState<Set<number>>(new Set())
  // Total estimated USD cost across every session -- the nav header figure.
  // Refreshed alongside the channel list on each catalog sync.
  const [totalCost, setTotalCost] = useState(0)
  const [elevated, setElevated] = useState(false)
  const [navWidth, setNavWidth] = useState(() => readStoredWidth('nav', 264))
  const [bladeWidth, setBladeWidth] = useState(() => readStoredWidth('blade', 216))
  // Command-deck redesign: the chat list is the expanded half of the sidebar;
  // collapsing it leaves just the 68px icon rail. Persisted window-local.
  const [sidebarExpanded, setSidebarExpanded] = useState(() => readStoredBool('sidebar', true))
  const [railExpanded, setRailExpanded] = useState(() => readStoredBool('rail', true))
  const [fsEntries, setFsEntries] = useState<import('../shared/ipc').FsEntry[]>([])
  const [createImageOpen, setCreateImageOpen] = useState(false)
  // Whether a turn is currently running for the open session. Flips true
  // right when Composer's onSend fires, flips false on that session's
  // 'result' event. This flag is what Composer uses to decide send-vs-queue,
  // and (with queuedCount) what LiveIndicator shows in the header.
  const [running, setRunning] = useState(false)
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([])
  const updateHoldRef = useRef(false)
  // Live-turn reconciliation (Plan 2 Task 10): a transient "typing" preview
  // built from accumulating engine:event deltas, rendered as a temporary
  // bubble at the bottom of Transcript while `running` is true. Cleared
  // (reduceLivePreview returns null) the instant `result` fires -- from then
  // on the durable engine:rows delivery (already appended into `items` via
  // appendRowsToItems as it arrived) is what's actually showing.
  const [livePreview, setLivePreview] = useState<LivePreview | null>(null)
  // Mirrors Composer's internal queue length (Task 10) purely for
  // LiveIndicator's 'queued' vs 'streaming' badge -- the queue's actual
  // add/remove/reorder state stays owned by Composer itself.
  const [queuedCount, setQueuedCount] = useState(0)
  // A process outside ClaudeCord (a terminal) holding the OPEN chat -- while
  // set, the composer is read-only. Seeded on open via api.getLock, then kept
  // current by engine:lockChanged.
  const [externalLock, setExternalLock] = useState<ExternalLock | null>(null)
  // Chats a live claude has under Remote Control (/rc) -- badged in the rail,
  // chat list, session list and chat header. App-wide, pushed by main.
  const [remote, setRemote] = useState<RemoteSession[]>([])
  const remoteProjects = useMemo(() => new Set(remote.map(r => r.projectId)), [remote])
  const pending = useMemo(() => pendingTools(items, running), [items, running])
  const pendingToolIds = useMemo(() => new Set(pending.map(p => p.toolUseId)), [pending])
  const remoteSessions = useMemo(() => new Set(remote.map(r => r.sessionPk)), [remote])
  useEffect(() => {
    void api.listRemote().then(setRemote).catch(() => { /* engine not ready: stays empty */ })
    return api.onRemoteChanged(setRemote)
  }, [])
  // Pending permission/plan-approval requests (Plan 2 Task 9), keyed by the
  // sessionPk they belong to -- NOT filtered to just the open session, so a
  // request that arrives for a session the user isn't currently looking at
  // is kept (not lost, not silently answered) and simply doesn't render
  // until the user switches to that session. Plan.get(session.id) below is
  // what actually narrows this down to what Transcript renders.
  const [permissionsByPk, setPermissionsByPk] = useState<Map<number, PermissionRequest[]>>(new Map())
  // Request ids whose blocked-turn banner the user dismissed (banner stays gone
  // until a new request arrives). Arrival times drive the banner countdown.
  const [dismissedPerms, setDismissedPerms] = useState<Set<string>>(new Set())
  const permArrivedRef = useRef<Map<string, number>>(new Map())
  // Per-session draft text, so switching away and back restores what was
  // being typed. A ref (not state) since it's read only when (re)mounting a
  // Composer, never needs to trigger a render itself.
  const draftsRef = useRef<Map<number, string>>(new Map())
  // Latest channels + open-project id, mirrored into refs so the app-wide
  // onIndexed listener (registered once, below) can diff against them without
  // re-subscribing on every channel/project change.
  const channelsRef = useRef<ChannelRow[]>([])
  const projectIdRef = useRef<number | null>(null)
  // Whether the transcript is following at the bottom (vs scrolled up reading
  // history). Reported by Transcript; gates the background-sync reload so a
  // sync never yanks the reader's scroll position. Defaults true -- a freshly
  // opened session lands at the bottom.
  const atBottomRef = useRef(true)
  // Bumped whenever we want the transcript to jump to the absolute bottom
  // imperatively (e.g. right after the user sends a message). Transcript watches
  // it and scrolls; the value itself is meaningless, only that it changed.
  const [scrollToBottomTick, setScrollToBottomTick] = useState(0)
  useEffect(() => { channelsRef.current = channels }, [channels])
  useEffect(() => { projectIdRef.current = project?.id ?? null }, [project])

  // Persist panel widths so a drag survives relaunch.
  useEffect(() => { window.localStorage.setItem('cc.width.nav', String(navWidth)) }, [navWidth])
  useEffect(() => { window.localStorage.setItem('cc.width.blade', String(bladeWidth)) }, [bladeWidth])
  useEffect(() => { window.localStorage.setItem('cc.ui.sidebar', sidebarExpanded ? '1' : '0') }, [sidebarExpanded])

  // Load the project's file tree + git status for the context rail whenever the
  // open project changes. Walked on demand (no watcher yet); cheap + bounded.
  useEffect(() => {
    const cwd = project?.cwd ?? null
    if (cwd === null) { setFsEntries([]); return }
    let cancelled = false
    void api.fsTree(cwd).then(entries => { if (!cancelled) setFsEntries(entries) }).catch(() => { if (!cancelled) setFsEntries([]) })
    return () => { cancelled = true }
  }, [project?.cwd])

  // Footer "Chat elevation level" line (Windows).
  useEffect(() => { void api.isElevated().then(setElevated) }, [])

  // Load settings once so the transcript can honour display prefs (e.g.
  // hiding tool-call cards). Kept live below via SettingsWindow.
  useEffect(() => { void api.getSettings().then(setSettings) }, [])

  // Theme: `<html data-theme>` drives the [data-theme="terminal"] overrides in
  // styles.css. Cached in localStorage so main.tsx can apply it before first
  // paint (no Discord flash while settings load).
  // `themeScope` decides whether the skin covers the whole window (<html>) or
  // just the chat pane (<main data-theme> below). Until settings load, the
  // cached choice is used so the first paint already matches.
  const cachedChoice = useMemo(cachedTheme, [])
  const themeChoice: ThemeChoice = settings === null
    ? cachedChoice
    : { theme: settings.theme, scope: settings.themeScope }
  useEffect(() => {
    if (settings === null) return
    applyTheme(themeChoice)
  }, [themeChoice.theme, themeChoice.scope])

  // Poll the engine pool for the chat-list footer count (the pool HUD polls
  // its own detail while open). Cheap and bounded to a handful of engines.
  useEffect(() => {
    let alive = true
    const tick = (): void => { void api.listEngines().then(e => { if (alive) setActiveChats(e.filter(x => x.busy).length) }).catch(() => {}) }
    tick()
    const id = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Re-pulls everything the nav derives from the catalog: channel list
  // (previews, timestamps, Today/Yesterday ordering), unread flags, the open
  // project's session list, and the total-cost figure. Held in a ref so the
  // once-registered onIndexed listener always calls the latest closure.
  function refreshNav(): void {
    void api.listChannels().then(list => {
      const prevActivity = new Map(channelsRef.current.map(c => [c.id, c.lastActivity] as const))
      setUnread(prev => {
        const next = new Set(prev)
        let changed = false
        for (const c of list) {
          if (c.id === projectIdRef.current) continue // the open channel is, by definition, read
          const before = prevActivity.get(c.id)
          // `before === undefined` = a channel we hadn't seen before this
          // sync (e.g. a brand-new project); don't retroactively flag it.
          if (before !== undefined && c.lastActivity !== before && !next.has(c.id)) {
            next.add(c.id); changed = true
          }
        }
        return changed ? next : prev
      })
      setChannels(list)
    }).catch(err => console.error('Nav refresh after catalog sync failed', err))
    void api.totalCost().then(setTotalCost).catch(() => { /* keep prior total */ })
    const pid = projectIdRef.current
    if (pid !== null) {
      void api.listSessions(pid).then(list => {
        if (projectIdRef.current === pid) setSessions(list)
      }).catch(() => { /* keep prior list */ })
    }
  }
  const refreshNavRef = useRef(refreshNav)
  refreshNavRef.current = refreshNav

  // Auto-clean removed old chats: drop them from the nav.
  useEffect(() => api.onRetentionCleaned(() => refreshNavRef.current()), [])

  // Keep the nav live: whenever a catalog sync completes (for ANY session, not
  // just the open one), re-pull the channel list so previews/timestamps
  // reflect the newest message, and flag any channel whose activity advanced
  // while it wasn't the open project as unread. Registered once for the app's
  // lifetime; reads current channels/open-project via refs so it never needs
  // to re-subscribe. Distinct from the session-scoped onIndexed reload below,
  // which only refreshes the open transcript.
  //
  // Coalesced: the external-change sweep can report several chats in one tick
  // (each its own `engine:indexed`), and a live turn emits one per row batch --
  // a short trailing debounce turns any burst into a single nav re-pull.
  // Also re-pulls the open project's session list so a chat continued
  // elsewhere bumps to the top of it even while the open transcript is
  // scrolled up (the session-scoped reload below skips that case).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.onIndexed(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refreshNavRef.current() }, 120)
    })
    return () => { off(); if (timer !== null) clearTimeout(timer) }
  }, [])

  // Ctrl/Cmd+K opens the global full-text search overlay from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Open a search result: resolve its channel by project slug, load that
  // channel's sessions, and open the specific session the hit belongs to
  // (which may live in a channel that isn't currently loaded).
  const openChatRef = useRef<(sessionPk: number, projectDir: string) => void>(() => {})
  // A desktop notification was clicked: open that chat.
  useEffect(() => api.onOpenChat((pk, dir) => openChatRef.current(pk, dir)), [])

  async function openSearchResult(sessionPk: number, projectDir: string) {
    setSearchOpen(false)
    const channel = channels.find(c => c.dirName === projectDir) ?? null
    const reqId = ++sessionReqId.current
    if (channel !== null) setProject(channel)
    const list = channel === null ? [] : await api.listSessions(channel.id)
    if (isStaleResponse(reqId, sessionReqId.current)) return
    setSessions(list)
    const target = list.find(s => s.id === sessionPk) ?? null
    if (target !== null) await openSession(target)
  }
  openChatRef.current = (pk, dir) => { setManageOpen(false); void openSearchResult(pk, dir) }

  // Guards two independent races the naive version misses:
  //  - clicking channels/sessions faster than their fetches resolve, which
  //    would otherwise let a stale response overwrite a newer selection
  //  - loadOlder firing twice before the first call resolves (fast repeated
  //    scroll or the auto-load-if-too-short effect racing a manual scroll),
  //    which would otherwise double-fetch and duplicate-prepend a page
  // sessionReqId is bumped synchronously on every openSession/openProject
  // call; loadingOlderRef is a ref (not state) so the check is synchronous
  // and not subject to React's state-update batching.
  const sessionReqId = useRef(0)
  const loadingOlderRef = useRef(false)
  // Task 10 fix pass 2: guards the onIndexed reload effect below against a
  // back-to-back QUEUED turn on the SAME still-open session. Composer drains
  // its queue the instant turn A's `result` flips `running` false, calling
  // App's onSend -- which bumps this ref -- to dispatch turn B immediately.
  // Meanwhile turn A's own `result` also kicked off a catalog sync whose
  // `engine:indexed` triggers an ASYNC `loadTranscript` reload; if that
  // reload resolves only after turn B's `onRows` has already appended durable
  // rows into `items`, a wholesale `setItems(page.items)` replace from turn
  // A's stale reload would drop turn B's rows from view (self-heals on turn
  // B's own settle, but a real, avoidable clobber in the meantime). The
  // reload effect captures this ref's value before its async
  // `loadTranscript`, then -- via `shouldApplyReload` -- only applies the
  // reload if the generation is STILL what it captured, i.e. no newer turn
  // has since started on this same session. `sessionReqId` alone can't catch
  // this: it only guards a reload against a session SWITCH, not a new turn
  // starting on the session that stayed open the whole time.
  const reloadGenRef = useRef(0)
  // Hard in-flight guard for createChat, mirroring loadingOlderRef above: a
  // fast double-click on the dialog's Create button can call this handler
  // twice before React re-renders with the button's `disabled` (driven by
  // NewChatDialog's own `creating` state) reflecting the first click --
  // that state is soft (async, batched) and does not stop a second
  // synchronous invocation from slipping through. This ref is checked and
  // set synchronously as the very first thing createChat does, before any
  // `await`, so the second concurrent call always observes it already true
  // and returns without ever reaching api.newChat -- otherwise each call
  // mints its own randomUUID() session id, minting two orphan empty
  // sessions in the same project instead of one.
  const creatingChatRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const off = api.onIndexProgress(p => { if (!cancelled) setProgress(p) })
    void (async () => {
      try {
        await api.runIndex()
        const [list, groupList, cost] = await Promise.all([api.listChannels(), api.listGroups(), api.totalCost()])
        if (cancelled) return
        setChannels(list)
        setGroups(groupList)
        setTotalCost(cost)
        setProgress(null)
      } catch (err) {
        // A failed first-run index must not leave the overlay stuck forever;
        // surface an empty app rather than an unrecoverable progress screen.
        console.error('Initial index failed', err)
        if (!cancelled) setProgress(null)
      } finally {
        // Reveal the window (and drop the launch splash) only once the first
        // load is done -- after two frames, so the populated nav has painted
        // and the window never flashes an empty shell. Idempotent in main.
        requestAnimationFrame(() => requestAnimationFrame(() => api.appReady()))
      }
    })()
    return () => { cancelled = true; off() }
  }, [])

  // Opening a session loads only the newest page; older pages arrive on scroll.
  async function openSession(next: SessionSummary) {
    const reqId = ++sessionReqId.current
    // Any loadOlder still in flight belonged to whatever session was open a
    // moment ago; it can no longer apply here. Clearing the flag up front
    // (rather than waiting for that stale call's own finally) means this
    // session's first auto-load-if-too-short check is never blocked behind
    // someone else's pending fetch.
    loadingOlderRef.current = false
    // A newly opened session lands at the bottom (following), until Transcript
    // reports otherwise -- so a sync right after open isn't wrongly skipped.
    atBottomRef.current = true
    setSession(next)
    setItems([]); setOldestSeq(null); setHasMore(false); setSessionLoading(true)
    setLoadingOlder(false); setTranscriptFileMissing(false)
    // A running turn (and its live preview / queued count) belongs to
    // whatever session was open a moment ago; none of it carries over to the
    // newly opened one -- Composer itself remounts fresh too (key=session.id).
    setRunning(false)
    setLivePreview(null)
    setQueuedCount(0)
    setExternalLock(null)
    try {
      // Refresh-on-open: if this chat's transcript changed on disk since the
      // catalog last saw it (continued from a terminal, say), re-index it
      // first so the page below is current -- and refresh the nav, whose
      // preview/ordering for this chat is just as stale.
      const refreshed = await api.syncSessionIfStale(next.id).catch(() => false)
      if (isStaleResponse(reqId, sessionReqId.current)) return
      if (refreshed) refreshNavRef.current()
      const page = await api.loadTranscript(next.id)
      if (isStaleResponse(reqId, sessionReqId.current)) return // superseded by a newer selection
      setItems(page.items); setOldestSeq(page.oldestSeq); setHasMore(page.hasMore)
      setTranscriptFileMissing(page.fileMissing ?? false)
      // Re-derive `running` when switching back to a session whose turn is
      // still streaming (Plan 3 Task 8 / Plan 2 review #6) — otherwise the
      // composer would wrongly allow a direct send into a live transport.
      const [live, lock] = await Promise.all([api.isSessionLive(next.id), api.getLock(next.id).catch(() => null)])
      if (!isStaleResponse(reqId, sessionReqId.current)) { setRunning(live); setExternalLock(lock) }
    } finally {
      if (!isStaleResponse(reqId, sessionReqId.current)) setSessionLoading(false)
    }
  }

  async function openProject(next: ChannelRow) {
    const reqId = ++sessionReqId.current
    setProject(next)
    // Opening a channel reads it: clear any unread glow it carried.
    setUnread(prev => {
      if (!prev.has(next.id)) return prev
      const n = new Set(prev); n.delete(next.id); return n
    })
    const list = await api.listSessions(next.id)
    if (isStaleResponse(reqId, sessionReqId.current)) return // a newer channel/session click won the race
    setSessions(list)
    // Spec: clicking a channel opens its newest-modified session.
    const newest = list[0] ?? null
    if (newest === null) {
      setSession(null); setItems([]); setOldestSeq(null); setHasMore(false)
      return
    }
    await openSession(newest)
  }

  // Submits the New-Chat dialog's resolved options to the engine, then --
  // on success -- refreshes the project/session lists (the new chat may
  // belong to a brand-new project the catalog didn't have a moment ago) and
  // opens the just-created session so the Composer is ready for its first
  // message. Mirrors openProject's own reqId-guarded refresh-then-open
  // shape; a stale response here (the user clicked a different
  // channel/session while this was in flight) is handled the same way --
  // silently dropped rather than clobbering whatever is now open.
  async function createChat(options: NewProjectOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    // See creatingChatRef's own comment above: this check-and-set happens
    // synchronously, before the first `await`, so a second synchronous
    // invocation (double-click) always observes the flag already set and
    // is a no-op here -- the in-flight call already owns this request.
    if (creatingChatRef.current) return { ok: true }
    creatingChatRef.current = true
    try {
      const outcome = await api.newChat(options)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      await openCreatedChat(options.cwd, outcome.sessionId)
      return { ok: true }
    } finally {
      creatingChatRef.current = false
    }
  }

  /** Shows a chat the main process just registered and opens it. */
  async function openCreatedChat(cwd: string, sessionId: string): Promise<void> {
    const list = await api.listChannels()
    setChannels(list)
    // setProjectCwd (main-process side of api.newChat) wrote this exact string,
    // so an exact match always finds it -- barring the defensive fallback below
    // for an unexpected catalog race.
    const proj = list.find(p => p.cwd === cwd) ?? null
    if (proj === null) {
      // The new chat is safely registered server-side regardless; it will simply
      // show up on the next listProjects refresh instead of opening immediately.
      setNewChatOpen(false)
      return
    }

    const reqId = ++sessionReqId.current
    setProject(proj)
    const sessList = await api.listSessions(proj.id)
    setNewChatOpen(false)
    if (isStaleResponse(reqId, sessionReqId.current)) return
    setSessions(sessList)
    const created = sessList.find(s => s.sessionId === sessionId) ?? null
    if (created !== null) await openSession(created)
  }

  // /clear: this chat stays in the history; a new one opens in the same folder.
  async function clearChat(): Promise<void> {
    if (session === null || creatingChatRef.current) return
    creatingChatRef.current = true
    try {
      const outcome = await api.clearChat(session.id)
      if (!outcome.ok) { setTerminalNotice(outcome.error); return }
      if (outcome.unchanged) return
      await openCreatedChat(outcome.cwd, outcome.sessionId)
    } finally {
      creatingChatRef.current = false
    }
  }
  const clearChatRef = useRef(clearChat)
  clearChatRef.current = clearChat

  // Wrapped in useCallback so its identity is stable across unrelated App
  // re-renders: it's passed to Transcript as onReachTop, which sits in a
  // useLayoutEffect dependency array there, and a fresh function every render
  // would re-run that effect constantly. session/oldestSeq/hasMore are its
  // only reactive dependencies — sessionReqId and loadingOlderRef are refs
  // (stable identity, read via .current) and the setters are stable too.
  const loadOlder = useCallback(async () => {
    if (session === null || oldestSeq === null || loadingOlderRef.current || !hasMore) return
    const reqId = sessionReqId.current
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const page = await api.loadTranscript(session.id, { before: oldestSeq })
      if (isStaleResponse(reqId, sessionReqId.current)) return // the session changed while this page was in flight
      if (page.items.length > 0) {
        setItems(prev => [...page.items, ...prev])
        setOldestSeq(page.oldestSeq)
      }
      // Defends against a page that reports hasMore with zero items, which
      // would otherwise loop loadOlder forever with no progress.
      setHasMore(page.hasMore && page.items.length > 0)
    } finally {
      // Only the call that still owns the current session may release the
      // lock — otherwise a stale call resolving after a session switch would
      // clear a flag a newer, still-in-flight loadOlder for the new session
      // just set, letting a second concurrent fetch slip through for it.
      if (!isStaleResponse(reqId, sessionReqId.current)) {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }
    }
  }, [session, oldestSeq, hasMore])

  // Tracks turn-running state AND the live typing preview for whatever
  // session is currently open, by watching engine events scoped to its pk.
  // Re-subscribes whenever the open session changes -- the closure captures
  // that session's id fresh each time, and the returned unsubscribe tears
  // down the previous session's listener, so a 'result' for a session that's
  // no longer open can never flip `running`/`livePreview` for whatever
  // session replaced it.
  //
  // reduceLivePreview owns the actual accumulate/replace/clear logic (Plan 2
  // Task 10): delta appends, assistant replaces wholesale, result clears.
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    const off = api.onEvent((sessionPk, ev) => {
      if (sessionPk !== sid) return
      setLastEventAt(Date.now())
      setLivePreview(prev => reduceLivePreview(prev, ev))
      if (ev.kind === 'init' && ev.mcpServers !== undefined) setMcpServers(ev.mcpServers)
      if (ev.kind === 'exit') setMcpServers(null)
      if (ev.kind === 'usage') setTurnTokens(n => n + ev.outputTokens)
      if (ev.kind === 'suggestion') setSuggestion(ev.text)
      if (ev.kind === 'init') setLiveModel(ev.model)
      // Also how a turn nobody sent shows up: Claude Code carrying on after a background task.
      if (ev.kind === 'init') setRunning(true)
      if (ev.kind === 'background') setBackgroundTasks(ev.tasks)
      if (ev.kind === 'exit') setBackgroundTasks([])
      if (ev.kind === 'result') void api.contextUsage(sid).then(c => { if (c !== null) setContext(c) })
      if (ev.kind === 'status') setLiveStatus(ev.status === 'compacting' ? ev.status : null)
      else if (clearsRunning(ev)) setLiveStatus(null)
      // Task 10 review Fix 1: previously only a `result` event cleared
      // `running`, so any other way a turn ends -- the transport exiting
      // without ever sending one (spawn failure, an Esc-triggered SIGINT, a
      // crash), or a send refused before any transport was even spawned
      // (`refused-external-live` / `unknown-session`) -- left `running`
      // stuck true forever: the composer stayed wedged in "streaming" mode,
      // unable to drain its queue or accept a retry. clearsRunning widens
      // the check to cover all of those terminal cases; reduceLivePreview's
      // own `exit` case already clears livePreview alongside it above.
      if (clearsRunning(ev)) setRunning(false)
    })
    return off
  }, [session])

  // MCP status for the open chat. A process already running answers straight away;
  // otherwise the first turn's init event brings it. While any server is still
  // starting, ask again: nothing else would report how it turned out.
  const sessionPk = session?.id ?? null
  useEffect(() => {
    setBackgroundTasks([])
    if (sessionPk === null) return
    let alive = true
    void api.backgroundTasks(sessionPk).then(t => { if (alive) setBackgroundTasks(t) })
    return () => { alive = false }
  }, [sessionPk])
  useEffect(() => {
    setMcpServers(null)
    if (sessionPk === null) return
    let alive = true
    void api.mcpStatus(sessionPk).then(s => { if (alive) setMcpServers(s) })
    return () => { alive = false }
  }, [sessionPk])
  useEffect(() => {
    setShellRuns([])
    if (sessionPk === null) return
    let alive = true
    void api.shellList(sessionPk).then(r => { if (alive) setShellRuns(r) })
    const off = api.onShellChanged((pk, runs) => { if (pk === sessionPk) setShellRuns(runs) })
    return () => { alive = false; off() }
  }, [sessionPk])
  useEffect(() => {
    if (!running) { setLiveStatus(null); return }
    const now = Date.now()
    setTurnStartedAt(now)
    setTurnTokens(0)
    setLastEventAt(now)
    setSuggestion(null)
    if (sessionPk === null) return
    // Coming back to a chat mid-turn: the engine pool knows the real figures.
    let alive = true
    void api.turnInfo(sessionPk).then(turn => {
      if (!alive || turn === null) return
      setTurnStartedAt(turn.startedAt)
      setTurnTokens(turn.tokens)
      setLastEventAt(turn.lastActivity)
    })
    return () => { alive = false }
  }, [running, sessionPk])
  // What belongs to one chat starts fresh when another opens.
  useEffect(() => {
    setSuggestion(null)
    setLiveModel(null)
    setContext(null)
    setProjectSettings({})
    if (sessionPk === null) return
    let alive = true
    void api.getProjectSettings(sessionPk).then(c => {
      if (!alive) return
      setProjectSettings(c)
      setRailExpanded(c.filesExpanded ?? readStoredBool('rail', true))
    })
    void api.contextUsage(sessionPk).then(c => { if (alive) setContext(c) })
    return () => { alive = false }
  }, [sessionPk])
  const toolDisplay = effectiveToolDisplay(settings?.toolDisplay ?? 'grouped', projectSettings)
  // The Files panel is remembered per project. The last choice is also kept as the
  // starting point for projects that haven't made one.
  const toggleFiles = (open: boolean): void => {
    setRailExpanded(open)
    window.localStorage.setItem('cc.ui.rail', open ? '1' : '0')
    if (sessionPk !== null) void api.setProjectSettings(sessionPk, { filesExpanded: open }).then(setProjectSettings)
  }
  const mcpStarting = mcpServers?.some(s => s.status === 'pending') ?? false
  useEffect(() => {
    if (sessionPk === null || !mcpStarting) return
    const timer = setInterval(() => { void api.mcpStatus(sessionPk).then(setMcpServers) }, 4000)
    return () => clearInterval(timer)
  }, [sessionPk, mcpStarting])

  // Keeps the open chat's external-lock state current (a terminal taking it
  // over or releasing it while it's open).
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    return api.onLockChanged((sessionPk, lock) => { if (sessionPk === sid) setExternalLock(lock) })
  }, [session])

  // Reconciles durable engine:rows deliveries into the transcript while a
  // turn streams (Plan 2 Task 10): the watcher tails the session's growing
  // JSONL file and hands us newly-appended rows, converted to render items
  // via the SAME buildRenderItems the read path uses (renderItemsFromStream-
  // edRows), then appended via appendRowsToItems -- which de-dupes so a
  // re-delivered row (e.g. a session re-open racing the live tail) never
  // double-renders. Scoped to the OPEN session only, same rationale as the
  // running/livePreview effect above: rows for a session the user isn't
  // looking at right now aren't reflected in any visible transcript, so
  // there's nothing useful to do with them here (the watcher keeps running
  // regardless -- disposeSession is a later concern, not this task's).
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    const off = api.onRows((sessionPk, rows) => {
      if (sessionPk !== sid) return
      const newItems = renderItemsFromStreamedRows(rows)
      // A row carrying only a tool's result adds no item but completes an earlier one.
      setItems(prev => appendRowsToItems(applyStreamedToolResults(prev, rows), newItems))
      if (newItems.length === 0) return
      // Task 10 review Fix 5: once a durable assistant row for the current
      // turn has landed here, it's authoritative -- suppress the SEALED
      // livePreview bubble for that same (now-completed) message so a
      // tool-using turn doesn't render both for the whole intervening tool
      // call. suppressSealedPreview leaves an UNSEALED preview (the message
      // still actively streaming) untouched.
      const hasAssistantRow = hasAssistantRenderItem(newItems)
      if (hasAssistantRow) setLivePreview(prev => suppressSealedPreview(prev, hasAssistantRow))
    })
    return off
  }, [session])

  // Task 10 review Finding 1's fix: once engine-ipc.ts's indexDebouncer has
  // synced a live turn's durable rows into the catalog, `loadTranscript` for
  // this session now returns them -- reload it (for the OPEN session only) so
  // the transcript is replaced by the authoritative, freshly-indexed render
  // instead of relying solely on the live-appended `items` from onRows above.
  // This is what makes "switch channels and back" show the just-completed
  // turn instead of whatever the catalog held at app mount.
  //
  // Bumps sessionReqId the same way openSession/loadOlder do, so a reload for
  // a since-switched-away-from session can never clobber whatever a newer
  // openSession call already put in state (the `isStaleResponse` check
  // below). Also resets loadingOlderRef/loadingOlder the same way openSession
  // does: bumping sessionReqId while a loadOlder for THIS session is still in
  // flight would otherwise make that call's own finally see itself as
  // "stale" and skip clearing the flag, permanently wedging loadOlder for the
  // rest of this session's lifetime -- this reload supersedes any in-flight
  // older-page fetch just like a fresh openSession would.
  //
  // Fix pass 2: ALSO captures reloadGenRef before the async loadTranscript
  // and re-checks it via shouldApplyReload once the fetch resolves -- guards
  // against a back-to-back QUEUED turn on this SAME session (see
  // reloadGenRef's own comment above). sessionReqId alone only catches a
  // session SWITCH; it does nothing for a newer turn starting on the session
  // that never closed. When the generation has moved on, this reload bails
  // WITHOUT touching `items` or `livePreview` -- the newer turn's own
  // onRows/onIndexed cycle already owns both and reflects the appended rows;
  // wholesale-replacing here would clobber them with the pre-turn-B page.
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    const off = api.onIndexed((sessionPk) => {
      if (sessionPk !== sid) return

      // Always refresh the open session's token totals so the header cost chip
      // tracks the conversation -- this is non-disruptive (just a header chip)
      // and must happen even while the user is reading history.
      const pid = projectIdRef.current
      if (pid !== null) {
        void api.listSessions(pid).then(sessList => {
          const updated = sessList.find(s => s.id === sid)
          if (updated !== undefined) setSession(prev => (prev !== null && prev.id === sid ? updated : prev))
        }).catch(() => { /* keep prior */ })
      }

      // Only reconcile the TRANSCRIPT when the user is following at the bottom.
      // If they've scrolled up reading history (possibly with older pages
      // loaded), a wholesale reload to the newest page would collapse those
      // pages and jump them to the bottom -- so leave their view untouched.
      if (!atBottomRef.current) return

      const reqId = ++sessionReqId.current
      const gen = reloadGenRef.current
      loadingOlderRef.current = false
      setLoadingOlder(false)
      void (async () => {
        try {
          const page = await api.loadTranscript(sid)
          if (!shouldApplyReload(reqId, sessionReqId.current, gen, reloadGenRef.current)) return
          setItems(page.items); setOldestSeq(page.oldestSeq); setHasMore(page.hasMore)
          setLivePreview(null)
          // This reload bumped sessionReqId, so an openSession for this same
          // chat still in flight will treat itself as stale and skip clearing
          // its loading flag -- clear it here since this page supersedes it.
          setSessionLoading(false)
          const p2 = projectIdRef.current
          if (p2 !== null) {
            const sessList = await api.listSessions(p2)
            if (shouldApplyReload(reqId, sessionReqId.current, gen, reloadGenRef.current)) setSessions(sessList)
          }
        } catch (err) {
          // A reload failing (e.g. a transient IPC hiccup) must not crash the
          // app -- the transcript simply keeps showing whatever it had
          // (the live-appended rows, or the last successful load) until the
          // next indexed/openSession event gives it another chance.
          console.error('Reload after catalog sync failed', err)
        }
      })()
    })
    return off
  }, [session])

  // Subscribes once for the app's lifetime (not scoped to the open session --
  // a request for a session that isn't open must still be kept, per Task 9's
  // guard, so it can be shown later if the user switches to it).
  useEffect(() => {
    const off = api.onPermission((sessionPk, req) => {
      permArrivedRef.current.set(req.id, Date.now())
      setPermissionsByPk(prev => {
        const next = new Map(prev)
        next.set(sessionPk, [...(next.get(sessionPk) ?? []), req])
        return next
      })
    })
    return off
  }, [])

  // Forwards a PermissionCard/PlanApprovalCard decision to the engine and
  // removes it from the pending list. `sessionPk` is passed explicitly
  // (rather than closing over `session`) so a decision on a request that
  // arrived for a session the user has since navigated away from still
  // removes it from the RIGHT session's list, not whatever is open now.
  const onResolvePermission = useCallback(
    (sessionPk: number, id: string, decision: 'allow' | 'allow_always' | 'deny', editedInput?: unknown, denyMessage?: string) => {
      api.resolvePermission(id, decision, editedInput, denyMessage)
      setPermissionsByPk(prev => {
        const list = prev.get(sessionPk)
        if (list === undefined) return prev
        const next = new Map(prev)
        next.set(sessionPk, list.filter(r => r.id !== id))
        return next
      })
    },
    []
  )

  const onSend = useCallback((text: string, images: ComposerImage[], pastedTexts: PastedTextChip[]) => {
    // Composer is only mounted while a session is open, so this is a
    // defensive no-op, not a reachable path.
    if (session === null) return
    const combined = buildOutgoingText(text, pastedTexts)
    // Guard: an empty send (whitespace-only, no images) is a no-op.
    if (combined.trim().length === 0 && images.length === 0) return
    // /clear would move Claude to a new session underneath this chat.
    if (isClearCommand(combined)) {
      void clearChatRef.current()
      return
    }
    // Terminal-only commands (/login, /hooks, …) can't work in headless mode:
    // offer to open the chat in a real Claude Code terminal instead.
    const command = terminalOnlyCommand(combined)
    if (command !== null && !bypassTerminalCheck.current) {
      setTerminalPrompt({ command, text: combined, images })
      return
    }
    bypassTerminalCheck.current = false
    setTerminalPrompt(null)
    setRunning(true)
    // Sending is an explicit "I'm caught up" gesture: jump the transcript to the
    // absolute bottom even if the user had scrolled up, and re-arm follow mode so
    // the reply streams in pinned to the bottom.
    atBottomRef.current = true
    setScrollToBottomTick(t => t + 1)
    // A new turn starts here -- invalidate any onIndexed reload for this
    // session that's still in flight (see reloadGenRef's own comment above):
    // it captured the PRE-bump generation, so shouldApplyReload will see it
    // as stale and bail rather than wholesale-replacing `items` out from
    // under this turn's own live rows.
    reloadGenRef.current++
    api.send(session.id, combined, images.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })))
  }, [session])

  // "Open in terminal" (header button, or the prompt for terminal-only
  // commands): hands the chat to the interactive Claude Code; the lock monitor
  // then keeps it read-only here until that terminal exits.
  const [terminalPrompt, setTerminalPrompt] = useState<{ command: string; text: string; images: ComposerImage[] } | null>(null)
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null)
  const bypassTerminalCheck = useRef(false)
  useEffect(() => { setTerminalPrompt(null); setTerminalNotice(null) }, [session?.id])
  const openChatInTerminal = useCallback(() => {
    if (session === null) return
    setTerminalNotice(null)
    void api.openInTerminal(session.id).then(r => {
      if (r.ok) setTerminalPrompt(null)
      else setTerminalNotice(r.error)
    })
  }, [session])

  const onInterrupt = useCallback(() => {
    if (session === null) return
    api.interrupt(session.id)
  }, [session])

  // ── Nav metadata editing (Plan 3 Task 2) ──────────────────────────────────
  // Every handler below is OPTIMISTIC: it updates `channels` (and, for group
  // create/delete, `groups`) synchronously from the same edit the user just
  // made, then fires the IPC call without awaiting it before returning --
  // the nav reflects the change immediately with no reload/flicker, and the
  // catalog write happens in the background. `patchMeta` is the shared
  // shape every per-field setter reduces to: replace one channel's `meta`
  // by dirName, leaving every other channel (and the channel's own other
  // meta fields) untouched.
  function patchMeta(dirName: string, patch: Partial<ChannelMeta>) {
    setChannels(prev => prev.map(c => (c.dirName === dirName ? { ...c, meta: { ...c.meta, ...patch } } : c)))
  }

  const onRenameChannel = useCallback((dirName: string, name: string | null) => {
    // Mirrors setFriendlyName's own normalization (metadata.ts): trim, and
    // store empty/whitespace-only as null -- so the optimistic update never
    // shows an untrimmed or blank name for the instant before the IPC round
    // trip would have corrected it anyway.
    const trimmed = name === null ? null : name.trim()
    patchMeta(dirName, { friendlyName: trimmed === null || trimmed.length === 0 ? null : trimmed })
    void api.setFriendlyName(dirName, name)
  }, [])

  const onToggleStar = useCallback((dirName: string, starred: boolean) => {
    patchMeta(dirName, { starred })
    void api.setStarred(dirName, starred)
  }, [])

  const onSetIcon = useCallback((dirName: string, icon: ChannelIcon) => {
    patchMeta(dirName, { icon })
    void api.setChannelIcon(dirName, icon)
  }, [])

  const onMoveToGroup = useCallback((dirName: string, groupId: number | null) => {
    patchMeta(dirName, { groupId })
    void api.setChannelGroup(dirName, groupId)
  }, [])

  const onToggleHidden = useCallback((dirName: string, hidden: boolean) => {
    patchMeta(dirName, { hidden })
    void api.setChannelHidden(dirName, hidden)
  }, [])

  // Delete wizard (port of ClaudeMemoryTool): project scope from the channel
  // menu, chat scope for the open chat or the channel's latest one.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const onDeleteChannel = useCallback((dirName: string) => {
    setDeleteTarget({ scope: 'project', dirName })
  }, [])
  const sessionRef = useRef<SessionSummary | null>(null)
  useEffect(() => { sessionRef.current = session }, [session])
  const onDeleteChat = useCallback((channel: ChannelRow) => {
    const open = sessionRef.current
    if (projectIdRef.current === channel.id && open !== null) { setDeleteTarget({ scope: 'chat', sessionPk: open.id }); return }
    void api.listSessions(channel.id).then(list => {
      const latest = list[0] // newest first
      if (latest !== undefined) setDeleteTarget({ scope: 'chat', sessionPk: latest.id })
    })
  }, [])
  // After a delete: if what was open is gone, drop back to the empty state;
  // then re-pull the nav (the catalog rows are already removed in main).
  const onDeleted = useCallback((target: DeleteTarget) => {
    const openProject = channelsRef.current.find(c => c.id === projectIdRef.current)
    const closeChat = target.scope === 'chat'
      ? sessionRef.current?.id === target.sessionPk
      : openProject !== undefined && (target.scope === 'project'
        ? openProject.dirName === target.dirName
        : target.dirNames.includes(openProject.dirName))
    if (closeChat) {
      setSession(null); setItems([]); setOldestSeq(null); setHasMore(false)
      if (target.scope !== 'chat') { setProject(null); setSessions([]) }
    }
    setManageEpoch(e => e + 1)
    refreshNavRef.current()
  }, [])

  // Manage screen (port of ClaudeMemoryTool): replaces the chat list + pane
  // while open. Its Delete… reuses the wizard above; `manageEpoch` tells it to
  // rescan after the wizard removed something.
  const [manageOpen, setManageOpen] = useState(false)
  const [manageEpoch, setManageEpoch] = useState(0)
  const onManageDelete = useCallback((target: DeleteTarget) => setDeleteTarget(target), [])
  // After a rename / import / restore: main has already re-synced the catalog;
  // re-pull the nav, and drop the open chat if its project is gone.
  const onManageChanged = useCallback(() => {
    void api.listChannels().then(list => {
      const pid = projectIdRef.current
      if (pid !== null && !list.some(c => c.id === pid)) {
        setSession(null); setItems([]); setOldestSeq(null); setHasMore(false); setProject(null); setSessions([])
      }
    }).catch(() => { /* the nav refresh below reports */ }).finally(() => refreshNavRef.current())
  }, [])
  const closeManage = useCallback(() => setManageOpen(false), [])

  // Awaited by ChannelContextMenu's "New group…" flow, which needs the new
  // group's id back so it can immediately move the channel into it (two
  // sequential edits from one submit).
  const onCreateGroup = useCallback(async (name: string): Promise<number> => {
    const id = await api.createGroup(name)
    setGroups(prev => [...prev, { id, name, sortOrder: 0, icon: { kind: 'initials' } }])
    return id
  }, [])

  // Optimistic group icon set (mirrors onSetIcon for channels).
  const onSetGroupIcon = useCallback((groupId: number, icon: ChannelIcon) => {
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, icon } : g)))
    void api.setGroupIcon(groupId, icon)
  }, [])

  // Guard: deleting a group the selected channel belongs to moves it to
  // Ungrouped -- mirrors the schema's own ON DELETE SET NULL (metadata.ts's
  // deleteGroup), applied optimistically here across every member channel
  // (not just whichever one the context menu was opened on) so the nav's
  // grouping updates for all of them, not just one.
  const onDeleteGroup = useCallback((groupId: number) => {
    setGroups(prev => prev.filter(g => g.id !== groupId))
    setChannels(prev => prev.map(c => (c.meta.groupId === groupId ? { ...c, meta: { ...c.meta, groupId: null } } : c)))
    void api.deleteGroup(groupId)
  }, [])

  // Optimistic group rename (renameGroup IPC already existed; this just wires
  // it to the context menu). Updates the nav's section title immediately.
  const onRenameGroup = useCallback((groupId: number, name: string) => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, name: trimmed } : g)))
    void api.renameGroup(groupId, trimmed)
  }, [])

  if (progress !== null) return <IndexProgress progress={progress} />

  // A pending permission request in a chat other than the open one raises the
  // app-wide banner (the open chat's own requests show as inline cards instead).
  const blocked = firstBlockedElsewhere(permissionsByPk, session?.id ?? null, dismissedPerms)
  const blockedChannel = blocked
    ? channels.find(c => c.dirName === projectDirFromSessionKey(blocked.req.sessionKey)) ?? null
    : null
  const blockedName = blockedChannel
    ? resolveChannelName(blockedChannel.meta, blockedChannel.cwd, blockedChannel.dirName)
    : 'Another chat'

  return (
    <div className="shell" data-density={settings?.density ?? 'comfortable'}>
      {/* The icon rail stands in for the chat list: its buttons move under the list while that's open. */}
      {(manageOpen || !sidebarExpanded) && (
        <IconRail channels={channels} groups={groups} selectedId={project?.id ?? null} unread={unread} remote={remoteProjects}
        sidebarExpanded={false}
        onSelect={p => { setManageOpen(false); void openProject(p) }}
        onToggleSidebar={() => { setManageOpen(false); setSidebarExpanded(true) }}
        onNewChat={() => setNewChatOpen(true)} onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => { setSettingsSection(undefined); setSettingsOpen(true) }}
        onOpenManage={() => setManageOpen(o => !o)} manageOpen={manageOpen} />
      )}
      {manageOpen && (
        <main className="main mg-main" data-theme={chatPaneTheme(themeChoice)}>
          <ManageView epoch={manageEpoch} onClose={closeManage} onDelete={onManageDelete} onChanged={onManageChanged} />
        </main>
      )}
      {!manageOpen && sidebarExpanded && (
        <>
          <Nav onShowInExplorer={c => { void api.showProjectFolder(c.id).then(r => { if (!r.ok) setTerminalNotice(r.error) }) }}
            onManageMemory={setMemoryChannel}
            onOpenManage={() => setManageOpen(true)} onOpenSettings={() => { setSettingsSection(undefined); setSettingsOpen(true) }}
            onCollapse={() => setSidebarExpanded(false)} channels={channels} groups={groups} selectedId={project?.id ?? null} width={navWidth}
            unread={unread} remote={remoteProjects} showRepos={githubReady} totalCost={totalCost} elevated={elevated} activeChats={activeChats}
            onSelect={p => void openProject(p)} onNewChat={() => setNewChatOpen(true)}
            onOpenSearch={() => setSearchOpen(true)} onOpenPool={() => setPoolOpen(true)}
            onRename={onRenameChannel} onToggleStar={onToggleStar} onMoveToGroup={onMoveToGroup}
            onCreateGroup={onCreateGroup} onDeleteGroup={onDeleteGroup} onRenameGroup={onRenameGroup}
            onSetGroupIcon={onSetGroupIcon} onSetIcon={onSetIcon}
            onToggleHidden={onToggleHidden} onDeleteChannel={onDeleteChannel} onDeleteChat={onDeleteChat} />
          <Resizer label="Resize channel list"
            onResize={dx => setNavWidth(w => clamp(w + dx, NAV_MIN, NAV_MAX))} />
        </>
      )}
      {/* Session Blade: opt-in (Settings → Appearance), and only when a channel
          actually has more than one session to pick between. Off by default in
          the command-deck layout (rail + list + chat + context rail). */}
      {!manageOpen && (settings?.showBlade ?? false) && sessions.length > 1 && (
        <>
          <Blade sessions={sessions} selectedId={session?.id ?? null} remote={remoteSessions} collapsed={collapsed} width={bladeWidth}
            onToggle={() => setCollapsed(c => !c)} onSelect={s => void openSession(s)} />
          {!collapsed && <Resizer label="Resize session list"
            onResize={dx => setBladeWidth(w => clamp(w + dx, BLADE_MIN, BLADE_MAX))} />}
        </>
      )}
      <main className="main" data-theme={chatPaneTheme(themeChoice)} hidden={manageOpen}>
        <UpdateBar />
        {settings !== null && !settings.retentionNoticeDismissed && (
          <RetentionNotice
            settingsOpen={settingsOpen}
            onOpenSettings={() => { setSettingsSection('history'); setSettingsOpen(true) }}
            onDismiss={() => { void api.updateSettings({ retentionNoticeDismissed: true }).then(setSettings) }} />
        )}
        {blocked && (
          <BlockedBanner channelName={blockedName} tool={blocked.req.tool}
            arrivedAt={permArrivedRef.current.get(blocked.req.id) ?? null}
            onReview={() => {
              if (blockedChannel) void openProject(blockedChannel)
              setDismissedPerms(prev => new Set(prev).add(blocked.req.id))
            }}
            onDeny={() => onResolvePermission(blocked.sessionPk, blocked.req.id, 'deny', undefined, 'Denied by user')}
            onDismiss={() => setDismissedPerms(prev => new Set(prev).add(blocked.req.id))} />
        )}
        <header className="chead">
          <div className="chead-main">
            <div className="chead-title-row">
              {!sidebarExpanded && (
                <button type="button" className="nav-head-caret" title="Show chat list"
                  aria-label="Show chat list" onClick={() => setSidebarExpanded(true)}>»</button>
              )}
              <h1>{project === null ? 'ClaudeCord' : resolveChannelName(project.meta, project.cwd, project.dirName)}</h1>
              {session !== null && <LiveIndicator running={running} queuedCount={queuedCount} />}
              {session !== null && mcpServers !== null && (
                <McpChip sessionPk={session.id} cwd={project?.cwd ?? null} servers={mcpServers}
                  ignored={settings?.mcpWarnIgnore ?? []} onServers={setMcpServers}
                  onIgnore={name => { void api.updateSettings({ mcpWarnIgnore: [...(settings?.mcpWarnIgnore ?? []), name] }).then(setSettings) }}
                  onOpenSettings={() => { setSettingsSection('mcp'); setSettingsOpen(true) }} />
              )}
              {session !== null && remoteSessions.has(session.id) && (
                <span className="rc-tag" title="Remote Control on — this chat can be driven from claude.ai or the Claude app">
                  <RemoteBadge className="rc-badge-inline" />Remote Control
                </span>
              )}
            </div>
            <div className="path">{project?.cwd ?? `${channels.length} projects indexed`}</div>
          </div>
          {session !== null && (
            <button type="button" className="chead-term" onClick={openChatInTerminal}
              title="Open this chat in Claude Code in a terminal: for /mcp, logins, reconnecting tools, and anything else the app can't do">
              ›_ Open in terminal
            </button>
          )}
          {session !== null && settings !== null && (
            <ProjectOptions settings={settings} chat={projectSettings}
              onChange={patch => { void api.setProjectSettings(session.id, patch).then(setProjectSettings) }}
              onOpenSettings={() => { setSettingsSection('appearance'); setSettingsOpen(true) }} />
          )}
          {session !== null && <ChatHeaderControls key={session.id} session={session} liveModel={liveModel} />}
        </header>
        {session === null
          ? <div className="empty">Pick a channel to start reading.</div>
          // Keyed on the session id: forces a fresh Transcript instance (and
          // fresh internal scroll/height refs) per session, so the scroll-
          // preservation math never mixes geometry from a previously open
          // session into the next one's first paint.
          // Passed by reference (not wrapped in a new arrow) so its identity
          // stays stable across renders, matching loadOlder's own useCallback
          // stability -- see Finding 5 in the fix-pass report.
          // Key is prefixed and distinct from the Composer's below: both are
          // direct children of <main> and both remount per session, but two
          // siblings sharing the same key value (session.id) is a duplicate-key
          // collision — React then fails to unmount the previous Transcript on a
          // session switch, stacking a new .stream under the stale one (each
          // switch leaked one, splitting the chat into 50/50 scroll boxes).
          : <Transcript key={`transcript-${session.id}`} items={items} hasMore={hasMore} loadingOlder={loadingOlder}
              loading={sessionLoading} onReachTop={loadOlder} livePreview={livePreview}
              showToolCalls={toolDisplay !== 'hidden'} groupToolCalls={toolDisplay === 'grouped'} fileMissing={transcriptFileMissing}
              claudeIcon={settings?.claudeIcon ?? { kind: 'initials' }}
              thinkingExpanded={settings?.thinkingExpanded ?? false}
              toolCardsExpanded={settings?.toolCardsExpanded ?? false}
              pendingToolIds={pendingToolIds}
              onAtBottomChange={v => { atBottomRef.current = v }}
              scrollToBottomSignal={scrollToBottomTick}
              permissionRequests={permissionsByPk.get(session.id) ?? []}
              onResolvePermission={(id, decision, editedInput, denyMessage) =>
                onResolvePermission(session.id, id, decision, editedInput, denyMessage)} />}
        {session !== null && (terminalPrompt !== null || terminalNotice !== null) && (
          <div className="term-prompt" role="status">
            {terminalPrompt !== null ? (
              <>
                <span><code>{terminalPrompt.command}</code> only works in Claude Code's terminal. Open this chat there? It continues right where it is, and ClaudeCord shows its replies.</span>
                <span className="term-prompt-actions">
                  <button type="button" className="btn-primary" onClick={openChatInTerminal}>Open in terminal</button>
                  <button type="button" className="btn-secondary" onClick={() => { bypassTerminalCheck.current = true; onSend(terminalPrompt.text, terminalPrompt.images, []) }}>Send anyway</button>
                  <button type="button" className="term-prompt-x" aria-label="Dismiss" onClick={() => setTerminalPrompt(null)}>✕</button>
                </span>
              </>
            ) : null}
            {terminalNotice !== null && (
              <span className="term-prompt-error">{terminalNotice}
                <button type="button" className="term-prompt-x" aria-label="Dismiss" onClick={() => setTerminalNotice(null)}>✕</button>
              </span>
            )}
          </div>
        )}
        {session !== null && running && (
          <WorkingLine startedAt={turnStartedAt} tokens={turnTokens} status={liveStatus} pending={pending} lastActivity={lastEventAt}
            waitingOnYou={(permissionsByPk.get(session.id)?.length ?? 0) > 0} />
        )}
        {session !== null && <BackgroundTasksLine tasks={backgroundTasks} running={running} />}
        {session !== null && <ShellRuns runs={shellRuns} />}
        {session !== null && (
          // Keyed on the session id (same reasoning as Transcript above): a
          // fresh Composer instance per session, so an in-progress queue/
          // chips/text never bleeds from one session into another. Only the
          // plain draft string survives the switch, via draftsRef.
          <Composer key={`composer-${session.id}`} running={running} lock={externalLock} cwd={project?.cwd ?? null} suggestion={suggestion}
            onShellCommand={command => { void api.shellRun(session.id, command) }}
            onHijack={async () => {
              const r = await api.hijackChat(session.id)
              if (!r.ok) return r.error
              setExternalLock(await api.getLock(session.id))
              return null
            }}
            initialDraft={draftsRef.current.get(session.id) ?? ''}
            onDraftChange={text => {
              draftsRef.current.set(session.id, text)
              // Drafts live only in this window, so an automatic update waits for them.
              const hold = [...draftsRef.current.values()].some(d => d.trim().length > 0)
              if (hold !== updateHoldRef.current) { updateHoldRef.current = hold; void api.setUpdateHold(hold) }
            }}
            onSend={onSend} onInterrupt={onInterrupt} onQueueLengthChange={setQueuedCount} />
        )}
      </main>
      {!manageOpen && (settings?.showContextRail ?? true) && (
        railExpanded
          ? <ContextRail session={session} fsEntries={fsEntries}
              hasKey={(settings?.openRouterKey ?? '').trim().length > 0}
              canCreateImage={typeof project?.cwd === 'string' && project.cwd.length > 0}
              onCreateImage={() => setCreateImageOpen(true)}
              onCollapse={() => toggleFiles(false)} context={context}
              onCompact={session !== null && !running && externalLock === null ? () => onSend('/compact', [], []) : undefined} />
          : <ContextRailStrip fsEntries={fsEntries} onExpand={() => toggleFiles(true)} />
      )}
      {createImageOpen && typeof project?.cwd === 'string' && project.cwd.length > 0 && (
        <CreateImageDialog cwd={project.cwd} onClose={() => setCreateImageOpen(false)}
          onSaved={() => { const c = project?.cwd; if (c) void api.fsTree(c).then(setFsEntries).catch(() => {}) }} />
      )}
      {deleteTarget !== null && (
        <DeleteWizard target={deleteTarget} onClose={() => setDeleteTarget(null)}
          onDeleted={() => onDeleted(deleteTarget)} />
      )}
      {newChatOpen && (
        // Seeds the dialog's cwd field from whatever project is currently
        // open (a convenience -- most new chats are "another chat in the
        // channel I'm already looking at"), never forces it: the field
        // stays freely editable and Browse still opens on any directory.
        <NewChatDialog
          defaults={{
            cwd: project?.cwd ?? settings?.defaultCwd ?? undefined,
            skipPermissions: settings?.defaultSkipPermissions ?? true,
            model: settings?.defaultModel ?? undefined,
            effort: settings?.defaultEffort ?? undefined
          }}
          confirmBypass={settings?.confirmBeforeBypass ?? false}
          onCancel={() => setNewChatOpen(false)}
          onCreate={createChat}
        />
      )}
      {searchOpen && (
        <SearchOverlay
          channels={channels}
          onClose={() => setSearchOpen(false)}
          onOpen={(pk, dir) => void openSearchResult(pk, dir)}
        />
      )}
      {memoryChannel !== null && <MemoryDialog projectId={memoryChannel.id} title={resolveChannelName(memoryChannel.meta, memoryChannel.cwd, memoryChannel.dirName)} onClose={() => setMemoryChannel(null)} />}
      {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} onSettingsChanged={setSettings}
        projectCwd={project?.cwd ?? null} initialSection={settingsSection}
        projects={channels.map(c => ({ dirName: c.dirName, cwd: c.cwd, name: resolveChannelName(c.meta, c.cwd, c.dirName) }))} />}
      {poolOpen && <EnginePool onClose={() => setPoolOpen(false)}
        channelNameFor={(sessionKey) => {
          const dir = projectDirFromSessionKey(sessionKey)
          const ch = dir !== null ? channels.find(c => c.dirName === dir) : undefined
          return ch ? resolveChannelName(ch.meta, ch.cwd, ch.dirName) : (sessionKey.split(/[\\/]/).pop() ?? 'chat')
        }} />}
    </div>
  )
}
