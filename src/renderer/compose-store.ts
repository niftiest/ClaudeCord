import { clearsRunning, queueReducer, type ComposerImage, type PastedTextChip, type QueueAction, type QueuedMessage } from './lib'
import type { LiveEvent } from '../shared/engine-types'

/** What's being composed in each chat, beyond the draft's text: pictures, long pastes and
 *  queued messages. It lives outside the message box, which is rebuilt for every chat, so
 *  opening another chat doesn't lose any of it, and the queue keeps following Claude Code
 *  while the chat isn't on screen. */

export type ComposeState = { pasted: PastedTextChip[]; images: ComposerImage[]; queue: QueuedMessage[] }

const EMPTY: ComposeState = { pasted: [], images: [], queue: [] }

/** The next message waiting here rather than in Claude Code's own queue. */
export function nextHeld(queue: QueuedMessage[]): QueuedMessage | undefined {
  return queue.find(m => !m.uuid)
}

/** The command in a `!` message, or null for anything else (or a bare `!`). */
export function shellCommandOf(text: string): string | null {
  const t = text.trimStart()
  if (!t.startsWith('!')) return null
  const command = t.slice(1).trim()
  return command.length > 0 ? command : null
}

export class ComposeStore {
  private readonly states = new Map<number, ComposeState>()
  private readonly listeners = new Set<() => void>()
  /** The chat whose message box is on screen; that box handles its own sending. */
  private open: number | null = null

  get = (sessionPk: number): ComposeState => this.states.get(sessionPk) ?? EMPTY

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  update(sessionPk: number, change: (state: ComposeState) => ComposeState): void {
    this.states.set(sessionPk, change(this.get(sessionPk)))
    for (const listener of this.listeners) listener()
  }

  dispatch(sessionPk: number, action: QueueAction): void {
    this.update(sessionPk, s => ({ ...s, queue: queueReducer(s.queue, action) }))
  }

  setOpen(sessionPk: number | null): void {
    this.open = sessionPk
  }

  /** Anything that exists only in this window, in any chat. */
  hasUnsent(): boolean {
    for (const s of this.states.values()) {
      if (s.pasted.length > 0 || s.images.length > 0 || s.queue.length > 0) return true
    }
    return false
  }

  /** Follows every chat's queue, whichever chat is on screen. */
  handleEvent(sessionPk: number, ev: LiveEvent, runShell: (sessionPk: number, command: string) => void): void {
    if (ev.kind === 'exit') this.dispatch(sessionPk, { type: 'holdAll' })
    if (ev.kind === 'commandLifecycle') {
      if (ev.state === 'started' || ev.state === 'completed') this.dispatch(sessionPk, { type: 'removeUuid', uuid: ev.uuid })
      // On screen, the box puts it back in front of the user. Elsewhere it waits to be seen.
      if (ev.state === 'cancelled' && sessionPk !== this.open) this.dispatch(sessionPk, { type: 'holdUuid', uuid: ev.uuid })
    }
    if (sessionPk === this.open || !clearsRunning(ev)) return
    // A queued `!` needs nothing from the chat being open. Anything else waits for it,
    // since sending can need a question answered first.
    const next = nextHeld(this.get(sessionPk).queue)
    if (next === undefined) return
    const command = shellCommandOf(next.text)
    if (command === null) return
    this.dispatch(sessionPk, { type: 'remove', id: next.id })
    runShell(sessionPk, command)
  }
}

export const composeStore = new ComposeStore()
