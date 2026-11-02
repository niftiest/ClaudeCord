import type { SpawnSpec } from './transport'
import type { BackgroundTask, LiveEvent, EngineSnapshot, TurnInfo } from '../../shared/engine-types'

/** Narrow surface of Transport the pool depends on -- lets tests inject a
 *  fake transport (no real child_process spawned) while the production
 *  factory wraps a real `new Transport(spec, { claudeBin })`. Node-only,
 *  same as transport.ts: this file must never import electron (enforced by
 *  tests/architecture.test.ts). */
export interface TransportLike {
  /** Asks the process something without starting a turn. */
  request?(subtype: string, extra?: object, timeoutMs?: number): Promise<unknown>
  start(): void
  send(msg: object): void
  interrupt(): void
  /** OS pid once spawned (for the pool HUD's kill button); optional so fakes
   *  needn't implement it. */
  readonly pid?: number | null
  /** Graceful shutdown (reap / app-quit): lets the process exit on its own and
   *  clean up its session-lock file, force-killing only as a fallback. Distinct
   *  from interrupt() (a hard Ctrl-C that cancels the in-flight turn). */
  close(): void
  on(cb: (e: LiveEvent) => void): void
  onExit(cb: (code: number | null) => void): void
}

export type TransportFactory = (spec: SpawnSpec) => TransportLike

/** Builds the event emitted (in place of spawning) when a send targets a
 *  session the pool has been told is externally live -- e.g. a terminal
 *  already running `claude` against the same session file. Spawning a
 *  second writer would corrupt the JSONL's ordering, so the send is dropped
 *  and this is surfaced instead. A fresh object literal per call (rather
 *  than one shared module-level constant) so there is no shared-mutable
 *  state a subscriber could accidentally mutate and have it bleed into a
 *  later, unrelated refusal. */
function refusedExternalLive(): LiveEvent {
  return { kind: 'other', type: 'refused-external-live' }
}

/** The parts of a spec the user can change on a running chat. Not the session id,
 *  which legitimately goes from "create" to "resume" after the first process. */
function settingsKey(spec: SpawnSpec): string {
  return JSON.stringify([spec.model, spec.effort, spec.permissionMode, spec.skipPermissions, spec.chrome, spec.maxBudgetUsd, spec.extraArgs?.includes('--prompt-suggestions') ?? false])
}

/** Claude Code's new list, keeping when each task started and how far it has got. */
function mergeBackgroundTasks(known: BackgroundTask[], incoming: BackgroundTask[], now: number): BackgroundTask[] {
  return incoming.map(t => {
    const before = known.find(k => k.id === t.id)
    return before === undefined ? { ...t, startedAt: now } : { ...t, startedAt: before.startedAt, lastTool: before.lastTool, tokens: before.tokens }
  })
}

type QueueItem = { key: string; spec: SpawnSpec; msg: object }

interface Entry {
  transport: TransportLike
  /** The spec this transport was spawned with (model/effort for the HUD). */
  spec: SpawnSpec
  /** When the transport was spawned (pool HUD uptime). */
  startedAt: number
  lastActivity: number
  /** Replace it on the next message: see restartForReload. */
  reload?: boolean
  /** Whether a turn is CURRENTLY in flight on this transport (vs the process
   *  being pooled but idle between turns). Set true on every send() and cleared
   *  when the transport emits its terminal `result` for that turn. This is the
   *  "a turn is actively running" signal the UI's running-state re-derivation
   *  needs -- distinct from `isLive` (the process merely exists), which stays
   *  true for an idle pooled transport and must NOT be read as "still running".*/
  busy: boolean
  /** When the current turn began, and the output tokens it has used so far. Kept
   *  here so a chat reopened mid-turn shows the real figures. */
  turnStartedAt: number
  turnTokens: number
  /** What this process has running in the background. They die with it, so it isn't
   *  idle while there are any, even though no turn is running. */
  backgroundTasks: BackgroundTask[]
  /** Set the instant this entry is reaped/shut down. Captured by closures
   *  passed to `transport.on`/`onExit` at spawn time, so a transport's own
   *  late-firing callbacks (e.g. a delayed OS-level exit after we've already
   *  reaped it) check the ENTRY OBJECT they closed over, not a fresh map
   *  lookup by key -- so they can never mistakenly touch a different, later
   *  transport that has since been spawned under the same session key. */
  disposed: boolean
}

/**
 * Owns the lifecycle of Transport instances, keyed by session key: lazy
 * spawn on first send, reuse a live transport, cap concurrency (queueing the
 * rest), reap idle transports, fan out events to subscribers, and refuse to
 * spawn a second writer against a session a terminal already holds.
 *
 * "Actively running" model (deliberately the simplest defensible one): a
 * transport counts against `maxConcurrent` from the moment it is spawned
 * (factory() + start()) until its `onExit` fires or it is reaped -- there is
 * no separate "mid-turn vs idle-but-alive" distinction for the cap. A live
 * transport whose turn has finished still holds its slot; `send()` to it
 * reuses it in place and does NOT consume an additional slot (there is
 * nothing new to admit against the cap). The only thing that force-frees a
 * slot held by an idle transport is `reapIdle` -- driven by `lastActivity`,
 * bumped on every `send()` and every event the transport emits, so a
 * long-running turn is never mistaken for idleness.
 */
export class SessionPool {
  private readonly maxConcurrent: number
  private readonly idleReapMs: number
  private readonly transportFactory: TransportFactory
  private readonly isExternallyLive: (sessionKey: string) => boolean
  private readonly now: () => number

  private readonly live = new Map<string, Entry>()
  private readonly subscribers = new Map<string, Array<(e: LiveEvent) => void>>()
  private readonly queue: QueueItem[] = []

  /** Set true by `shutdown()`. Terminal: a pool is single-use (shutdown is
   *  meant for app-quit), so once set, `send()`/`interrupt()`/`reapIdle()`
   *  become safe no-ops instead of silently respawning transports as if
   *  shutdown never happened. */
  private stopped = false
  /** Ensures the use-after-shutdown warning is logged once, not once per
   *  stray call, so a caller that keeps poking a shut-down pool doesn't
   *  flood the console. */
  private warnedAfterShutdown = false

  private readonly waitingForExit = new Map<string, Array<() => void>>()

  constructor(opts: {
    maxConcurrent: number
    idleReapMs: number
    transportFactory: TransportFactory
    /** Predicate the pool consults before every spawn attempt (initial and
     *  at drain time) -- return true when a terminal (or anything outside
     *  the pool) already holds this session's file. Defaults to "never". */
    isExternallyLive?: (sessionKey: string) => boolean
    /** Injectable clock so idle-tracking is deterministic under test (a
     *  fake clock closure). Defaults to `Date.now`. Not part of the task
     *  brief's literal interface, but required to test "updated on send and
     *  on each event" without depending on wall-clock timing. */
    now?: () => number
  }) {
    this.maxConcurrent = opts.maxConcurrent
    this.idleReapMs = opts.idleReapMs
    this.transportFactory = opts.transportFactory
    this.isExternallyLive = opts.isExternallyLive ?? (() => false)
    this.now = opts.now ?? Date.now
  }

  /** Lazy-spawns on first send for a key that isn't live; reuses a live
   *  transport's process for subsequent sends; queues the send when the key
   *  isn't live and the pool is already at `maxConcurrent`; refuses (with a
   *  `refused-external-live` event) instead of either when the session is
   *  externally live. */
  send(sessionKey: string, spec: SpawnSpec, msg: object): void {
    if (this.stopped) {
      this.warnUseAfterShutdown()
      return
    }

    // Still waiting for an old process to exit: this message goes after the ones ahead of it.
    const waiting = this.waitingForExit.get(sessionKey)
    if (waiting !== undefined) {
      waiting.push(() => this.send(sessionKey, spec, msg))
      return
    }

    const entry = this.live.get(sessionKey)
    // A process keeps the settings it started with, so an idle one whose settings
    // have since changed makes way for a new one, which resumes the same chat. The new
    // one has to wait for the old to exit: until then its session lock still stands,
    // and it would read as another program holding the chat.
    // Not while it has background work: replacing it would kill that work, so this
    // message goes to the process as it is.
    if (entry !== undefined && !entry.busy && !entry.disposed && entry.backgroundTasks.length === 0 && (entry.reload === true || settingsKey(entry.spec) !== settingsKey(spec))) {
      const after: Array<() => void> = [() => this.send(sessionKey, spec, msg)]
      this.waitingForExit.set(sessionKey, after)
      entry.transport.onExit(() => {
        this.waitingForExit.delete(sessionKey)
        for (const next of after) next()
      })
      this.releaseIdle(sessionKey)
      return
    }
    if (entry !== undefined) {
      entry.lastActivity = this.now()
      if (!entry.busy) { entry.turnStartedAt = this.now(); entry.turnTokens = 0 }
      entry.busy = true // a new turn is starting on this reused transport
      entry.transport.send(msg)
      return
    }

    if (this.isExternallyLive(sessionKey)) {
      this.emitTo(sessionKey, refusedExternalLive())
      return
    }

    if (this.live.size >= this.maxConcurrent) {
      this.queue.push({ key: sessionKey, spec, msg })
      return
    }

    this.spawn(sessionKey, spec, msg)
  }

  /** Forwards to the live transport for a key that is live. Also cancels any
   *  queued-but-not-yet-spawned send(s) for that key, so an interrupt issued
   *  before a queued send has drained actually prevents it from firing
   *  later instead of silently letting it through once a slot frees up. A
   *  key that is neither live nor queued is a no-op. */
  interrupt(sessionKey: string): void {
    if (this.stopped) {
      this.warnUseAfterShutdown()
      return
    }

    this.live.get(sessionKey)?.transport.interrupt()

    if (this.queue.length > 0) {
      const remaining = this.queue.filter((item) => item.key !== sessionKey)
      if (remaining.length !== this.queue.length) {
        this.queue.length = 0
        this.queue.push(...remaining)
      }
    }
  }

  isLive(sessionKey: string): boolean {
    return this.live.has(sessionKey)
  }

  /** Whether a turn is CURRENTLY streaming for this key -- a live entry whose
   *  `busy` flag hasn't been cleared by a terminal `result` yet. Distinct from
   *  `isLive`: an idle-but-pooled transport is live (owns its slot, blocks a
   *  second external writer) but NOT running a turn. The UI's running-state
   *  re-derivation reads THIS, so reopening a chat with an idle pooled process
   *  no longer wrongly wedges the composer into "streaming/queue" mode. */
  isTurnRunning(sessionKey: string): boolean {
    const entry = this.live.get(sessionKey)
    return entry !== undefined && !entry.disposed && entry.busy
  }

  /** The running turn's start, tokens and last sign of life, or null when no turn is running. */
  turnInfo(sessionKey: string): TurnInfo | null {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed || !entry.busy) return null
    return { startedAt: entry.turnStartedAt, tokens: entry.turnTokens, lastActivity: entry.lastActivity }
  }

  /** What this chat's process is running in the background. */
  backgroundTasks(sessionKey: string): BackgroundTask[] {
    return this.live.get(sessionKey)?.backgroundTasks ?? []
  }

  /** A snapshot of every live engine for the pool HUD (engine:list). */
  snapshot(): EngineSnapshot[] {
    const out: EngineSnapshot[] = []
    for (const [sessionKey, entry] of this.live) {
      if (entry.disposed) continue
      out.push({
        sessionKey,
        pid: entry.transport.pid ?? null,
        model: entry.spec.model ?? null,
        effort: entry.spec.effort ?? null,
        startedAt: entry.startedAt,
        lastActivity: entry.lastActivity,
        busy: entry.busy,
        background: entry.backgroundTasks.length
      })
    }
    return out
  }

  /** Gracefully close+dispose the engine with this pid (HUD kill button), then
   *  drain the queue. Returns true if one was found. */
  killByPid(pid: number): boolean {
    for (const [key, entry] of this.live) {
      if (!entry.disposed && entry.transport.pid === pid) {
        this.dispose(key, entry)
        this.drainQueue()
        return true
      }
    }
    return false
  }

  /** Gracefully close+dispose this session's transport if it is pooled but
   *  IDLE (no turn in flight), then drain the queue. Used when another process
   *  (a terminal) takes the chat over: our idle process's in-memory
   *  conversation is now stale, and reusing it on the next send would fork the
   *  transcript -- releasing it means the next send respawns with a fresh
   *  `--resume` that reads the up-to-date JSONL. A mid-turn transport is left
   *  alone (killing it would lose the in-flight turn). Returns true if one
   *  was released. */
  releaseIdle(sessionKey: string): boolean {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed || entry.busy || entry.backgroundTasks.length > 0) return false
    this.dispose(sessionKey, entry)
    this.drainQueue()
    return true
  }

  /** Something a process only reads at startup has changed: the chat's next message
   *  starts a new one, which resumes where it was. One mid-reply finishes first. */
  restartForReload(sessionKey: string): 'restarted' | 'afterTurn' | 'none' {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed) return 'none'
    entry.reload = true
    return entry.busy || entry.backgroundTasks.length > 0 ? 'afterTurn' : 'restarted'
  }

  /** Asks a live process something (not a turn: it doesn't count as activity).
   *  Null when this chat has no process running. */
  request(sessionKey: string, subtype: string, extra?: object, timeoutMs?: number): Promise<unknown> | null {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed) return null
    return entry.transport.request?.(subtype, extra, timeoutMs) ?? null
  }

  /** Registers a subscriber for a session's events. Registration is
   *  independent of whether the session is currently live -- a subscriber
   *  registered before the first spawn still receives events once it
   *  spawns (and across any later respawn under the same key). */
  on(sessionKey: string, cb: (e: LiveEvent) => void): void {
    const list = this.subscribers.get(sessionKey)
    if (list !== undefined) list.push(cb)
    else this.subscribers.set(sessionKey, [cb])
  }

  /** Caller-ticked (no internal timer): gracefully closes+disposes any
   *  transport idle longer than `idleReapMs`, freeing its slot, then drains the
   *  queue. Losing a reaped transport loses nothing -- all durable state is
   *  in the JSONL the CLI writes; the pool only holds the in-flight process.
   *
   *  Tuning note: idleness here is measured purely by the ABSENCE of
   *  activity (a `send()` or an emitted event) for `idleReapMs`, not by
   *  whether the turn is actually finished. A turn that is genuinely
   *  in-flight but quiet for a stretch -- e.g. a long-running tool call
   *  that emits no events while it works -- looks identical to a truly idle
   *  transport from here. Whoever tunes `idleReapMs` MUST set it larger
   *  than the longest expected silent gap within a turn, or a live,
   *  in-progress response can be reaped mid-turn. */
  reapIdle(nowMs: number): void {
    if (this.stopped) {
      this.warnUseAfterShutdown()
      return
    }

    // Snapshot before iterating: disposing entries can synchronously spawn
    // new ones via drainQueue, and a Map iterator observes keys inserted
    // during iteration. A snapshot keeps this pass over exactly the entries
    // that existed when reapIdle was called.
    const snapshot = [...this.live.entries()]
    for (const [key, entry] of snapshot) {
      if (entry.disposed || entry.backgroundTasks.length > 0) continue
      if (nowMs - entry.lastActivity > this.idleReapMs) {
        this.dispose(key, entry)
      }
    }
    this.drainQueue()
  }

  /** Gracefully closes+disposes every live transport and clears the queue.
   *  Idempotent: a second call finds nothing live and an empty queue, so it
   *  is a safe no-op.
   *
   *  Terminal: a `SessionPool` is single-use. `shutdown()` is meant for app
   *  quit -- once called, the pool never spawns again. `send()`,
   *  `interrupt()`, and `reapIdle()` all become no-ops afterward (each logs
   *  a one-time warning) rather than silently respawning transports as if
   *  shutdown had never happened. Construct a new `SessionPool` if a fresh
   *  one is needed. */
  shutdown(): void {
    const snapshot = [...this.live.entries()]
    for (const [key, entry] of snapshot) this.dispose(key, entry)
    this.queue.length = 0
    this.stopped = true
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private warnUseAfterShutdown(): void {
    if (this.warnedAfterShutdown) return
    this.warnedAfterShutdown = true
    console.warn('[pool] use after shutdown')
  }

  private spawn(sessionKey: string, spec: SpawnSpec, msg: object): void {
    const transport = this.transportFactory(spec)
    const now = this.now()
    const entry: Entry = { transport, spec, startedAt: now, lastActivity: now, busy: true, turnStartedAt: now, turnTokens: 0, backgroundTasks: [], disposed: false }
    this.live.set(sessionKey, entry)

    transport.on((e) => {
      // Guards against a stale transport's late event landing after this
      // entry has been reaped/shut down (and possibly replaced by a fresh
      // spawn under the same key, which has its own Entry/closures).
      if (entry.disposed) return
      entry.lastActivity = this.now()
      // The turn's terminal `result` marks the transport idle again -- it stays
      // pooled (isLive true) but is no longer running a turn (isTurnRunning
      // false), so the UI stops showing it as streaming.
      if (e.kind === 'result') entry.busy = false
      if (e.kind === 'usage') entry.turnTokens += e.outputTokens
      // Nobody sent this turn: a background task finished and Claude Code carried on.
      if (e.kind === 'init' && !entry.busy) {
        entry.busy = true
        entry.turnStartedAt = entry.lastActivity
        entry.turnTokens = 0
      }
      if (e.kind === 'background') {
        entry.backgroundTasks = mergeBackgroundTasks(entry.backgroundTasks, e.tasks, entry.lastActivity)
        this.emitTo(sessionKey, { kind: 'background', tasks: entry.backgroundTasks })
        return
      }
      if (e.kind === 'taskProgress') {
        entry.backgroundTasks = entry.backgroundTasks.map(t => t.id === e.taskId ? { ...t, lastTool: e.lastTool ?? t.lastTool, tokens: e.tokens ?? t.tokens } : t)
        this.emitTo(sessionKey, { kind: 'background', tasks: entry.backgroundTasks })
        return
      }
      this.emitTo(sessionKey, e)
    })

    transport.onExit((code) => {
      // A transport that exits on its own (clean finish OR a mid-turn
      // crash) frees its slot and drains the queue exactly like a reap
      // does -- from the pool's perspective those are the same event.
      if (entry.disposed) return
      entry.disposed = true
      // Fan out a terminal `exit` LiveEvent BEFORE removing the entry, so
      // every subscriber (the coordinator, then the renderer) learns the
      // turn ended even when the transport never emitted its own `result`
      // -- a spawn error (claude not on PATH), an Esc-triggered SIGINT, or a
      // mid-turn crash all land here. The `entry.disposed` guard above
      // still applies first, so a reaped/shut-down entry's own late exit
      // (already handled by `dispose()`) never double-fires this.
      this.emitTo(sessionKey, { kind: 'exit', code })
      this.live.delete(sessionKey)
      this.drainQueue()
    })

    transport.start()
    transport.send(msg)
  }

  private dispose(sessionKey: string, entry: Entry): void {
    if (entry.disposed) return
    entry.disposed = true
    this.live.delete(sessionKey)
    // GRACEFUL close (not interrupt): reap/shutdown should let `claude` exit on
    // its own so it removes its ~/.claude/sessions/<pid>.json lock. A hard kill
    // here (the old interrupt() path) orphaned that lock, which then made a
    // later `claude --continue` in the same dir report "no previous conversation".
    entry.transport.close()
  }

  private drainQueue(): void {
    // Single pass, front-to-back, re-checking `this.live` fresh on every
    // item (not just once up front): a reused item spawned earlier in THIS
    // SAME pass must be visible to a later item for the same key, so two
    // queued sends for one not-yet-live key resolve to one spawn plus one
    // reuse, both landing in this call -- not one spawn now and the second
    // stuck waiting for a slot that reuse never needed in the first place.
    const remaining: QueueItem[] = []
    for (const item of this.queue) {
      const existing = this.live.get(item.key)
      if (existing !== undefined) {
        // Already live (spawned earlier in this pass, or otherwise) --
        // reusing a slot it already holds, so the cap never applies here.
        existing.lastActivity = this.now()
        existing.transport.send(item.msg)
        continue
      }

      // Re-check at drain time, not just at enqueue time: the session may
      // have become externally live while this send was waiting in queue.
      if (this.isExternallyLive(item.key)) {
        this.emitTo(item.key, refusedExternalLive())
        continue
      }

      if (this.live.size < this.maxConcurrent) {
        this.spawn(item.key, item.spec, item.msg)
        continue
      }

      remaining.push(item)
    }
    this.queue.length = 0
    this.queue.push(...remaining)
  }

  private emitTo(sessionKey: string, e: LiveEvent): void {
    const list = this.subscribers.get(sessionKey)
    if (list === undefined) return
    for (const cb of list) cb(e)
  }
}
