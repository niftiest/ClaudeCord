import { clearsRunning, queueReducer, type ComposerImage, type PastedTextChip, type QueueAction, type QueuedMessage } from './lib'
import type { LiveEvent, PromptEnding } from '../shared/engine-types'

/** What's being composed in each chat, beyond the draft's text: pictures, long pastes and
 *  queued messages. It lives outside the message box, which is rebuilt for every chat, so
 *  opening another chat doesn't lose any of it, and the queue keeps following Claude Code
 *  while the chat isn't on screen. */

export type ComposeState = {
  pasted: PastedTextChip[]
  images: ComposerImage[]
  queue: QueuedMessage[]
  /** A message that didn't reach Claude, waiting for this chat's box to take it back. */
  returned?: string | null
  /** Something to tell the user, waiting for this chat to be on screen. */
  notice?: string | null
}

const EMPTY: ComposeState = { pasted: [], images: [], queue: [] }

type SentMessage = { text: string; images: ComposerImage[] }

const ENDINGS: Record<string, string> = {
  blocked_by_hook: 'A hook blocked this message.',
  stopped_by_hook: 'A hook stopped this message before Claude replied.',
  dropped_by_hook: 'A plugin stopped this message.',
  not_passed_on: 'A plugin stopped this message.',
  no_verdict: "A hook couldn't check this message, so Claude didn't reply."
}

/** What to tell the user about a message that ended early. The hook's own reason is
 *  plain text from outside the app, so it's kept short and never treated as anything else. */
export function promptEndingNotice(ending: PromptEnding, returned: boolean): string {
  const lead = (ending.kind !== null ? ENDINGS[ending.kind] : undefined) ?? "This message didn't reach Claude."
  const said = ending.reason?.trim().slice(0, 400) ?? ''
  const reason = said.length > 0 && !/[.!?:]$/.test(said) ? `${said}.` : said
  const after = returned ? "It's back in the message box." : ending.kept ? 'Claude will see it with your next message.' : ''
  return [lead, reason, after].filter(s => s.length > 0).join(' ')
}

/** What to tell the user when Claude Code couldn't save something. */
export function writesLostNotice(errorCode: string, lost: string[]): string {
  const why = errorCode === 'EDQUOT' ? 'your disk quota is used up' : 'your disk is full'
  const chat = lost.includes('transcript')
  const what = chat ? 'part of a chat' : "Claude Code's settings"
  return `Claude Code couldn't save ${what} because ${why}.${chat ? ' Claude may not remember the latest messages when that chat resumes.' : ''} Free up some space to avoid losing more.`
}

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
  /** Each chat's message going through Claude Code now, so it can come back if it ends early. */
  private readonly current = new Map<number, SentMessage>()
  /** Messages given to Claude Code during a turn, until each one starts. */
  private readonly waiting = new Map<string, SentMessage>()

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

  /** A message going to Claude Code. With a uuid it waits its turn there. */
  noteSent(sessionPk: number, text: string, images: ComposerImage[], uuid?: string): void {
    if (uuid === undefined) this.current.set(sessionPk, { text, images })
    else this.waiting.set(uuid, { text, images })
  }

  /** Anything that exists only in this window, in any chat. */
  hasUnsent(): boolean {
    for (const s of this.states.values()) {
      if (s.pasted.length > 0 || s.images.length > 0 || s.queue.length > 0 || (s.returned ?? '').length > 0) return true
    }
    return false
  }

  /** Follows every chat's queue, whichever chat is on screen. */
  handleEvent(sessionPk: number, ev: LiveEvent, runShell: (sessionPk: number, command: string) => void): void {
    if (ev.kind === 'exit') this.dispatch(sessionPk, { type: 'holdAll' })
    if (ev.kind === 'informational') this.handleInformational(sessionPk, ev.text, ev.level, ev.ending)
    if (ev.kind === 'writesLost') this.update(sessionPk, s => ({ ...s, notice: writesLostNotice(ev.errorCode, ev.lost) }))
    if (clearsRunning(ev)) this.current.delete(sessionPk)
    if (ev.kind === 'commandLifecycle') {
      if (ev.state === 'started') {
        const sent = this.waiting.get(ev.uuid)
        if (sent !== undefined) this.current.set(sessionPk, sent)
      }
      if (ev.state !== 'queued') this.waiting.delete(ev.uuid)
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

  private handleInformational(sessionPk: number, text: string, level: string, ending: PromptEnding | undefined): void {
    if (ending === undefined) {
      if (level === 'warning') this.update(sessionPk, s => ({ ...s, notice: text.slice(0, 600) }))
      return
    }
    const sent = ending.kept ? undefined : this.current.get(sessionPk)
    this.update(sessionPk, s => ({
      ...s,
      notice: promptEndingNotice(ending, sent !== undefined),
      ...(sent === undefined ? {} : {
        returned: [sent.text, s.returned ?? ''].filter(t => t.length > 0).join('\n'),
        images: [...sent.images, ...s.images]
      })
    }))
  }
}

export const composeStore = new ComposeStore()
