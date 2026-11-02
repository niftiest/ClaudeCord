import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import {
  collapsePastedText, queueReducer, imageFromDataUrl, buildOutgoingText,
  applyCompletion, commandTokenLength, completionAt, fileMention, filterCommands, matchesCommandName, rankFiles,
  type ComposerImage, type PastedTextChip, type QueuedMessage
} from '../lib'
import type { ExternalLock } from '../../shared/engine-types'
import { HIJACK_WORKING_TEXT, hijackBlock } from '../../shared/hijack'
import type { ClaudeCommand, CommandSource } from '../../shared/claude-info-types'
import { CompletionMenu, useClaudeCommands, useProjectFiles, type MenuItem } from './ComposerMenu'

const MAX_TEXTAREA_PX = 200

const SOURCE_TAG: Record<CommandSource, string | null> = { project: 'project', user: 'personal', plugin: null, synced: 'synced', mcp: 'MCP', builtin: null }

function commandMenuItem(c: ClaudeCommand): MenuItem {
  return { key: c.name, primary: `/${c.name}`, secondary: c.description || c.argumentHint, tag: c.plugin ?? SOURCE_TAG[c.source] }
}

function fileMenuItem(path: string): MenuItem {
  const trimmed = path.replace(/\/$/, '')
  const slash = trimmed.lastIndexOf('/')
  return { key: path, primary: path.endsWith('/') ? `${trimmed.slice(slash + 1)}/` : trimmed.slice(slash + 1), secondary: slash === -1 ? '' : trimmed.slice(0, slash + 1), tag: null }
}

let nextChipId = 0
/** Local-only id generator for chips/queue entries (never sent to the
 *  engine). A plain incrementing counter is enough -- these ids only need to
 *  be unique within one Composer instance's lifetime, not globally, and
 *  avoids pulling in a uuid dependency for pure UI bookkeeping. */
function localId(prefix: string): string {
  nextChipId += 1
  return `${prefix}-${nextChipId}`
}

/** Reads a File (an image pasted from the clipboard or dropped) as a data
 *  URL, then hands it to imageFromDataUrl. Isolated in its own function so
 *  the FileReader/async plumbing stays out of the event handlers below. */
function readImageFile(file: File): Promise<ComposerImage | null> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(imageFromDataUrl(result, localId('img'), file.name))
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** The message input at the bottom of an open chat: multiline textarea
 *  (Enter sends, Shift+Enter newlines), large pastes collapse to a chip,
 *  pasted/dropped images become chips, and typing while a turn is running
 *  queues the message instead of sending it. Esc is a two-step "fast-track":
 *  the first Esc pulls the newest queued message back into the box to edit,
 *  and Esc with nothing queued interrupts the running turn -- so an urgent
 *  message can jump ahead of the queue and be sent immediately.
 *
 *  Keyed by the parent on `sessionPk` (App.tsx passes `key={session.id}`) so
 *  switching sessions remounts this component fresh -- the in-progress
 *  queue/chips/text of session A can never bleed into session B. Plain
 *  in-box draft text alone survives a switch, via the parent-owned
 *  initialDraft/onDraftChange pair.
 */
/** "a terminal" / "another Claude app" + pid, for the read-only notice. */
function lockHolder(lock: ExternalLock): string {
  const who = lock.entrypoint === 'cli' ? 'a terminal' : 'another Claude process'
  return `${who} (PID ${lock.pid})`
}

export function Composer({ running, lock = null, cwd = null, suggestion = null, onHijack, onShellCommand, initialDraft, onDraftChange, onSend, onInterrupt, onQueueLengthChange }: {
  /** True while a turn is in flight for this session. Enter queues instead
   *  of sending, and Esc interrupts, only while this is true. */
  running: boolean
  /** Set while a process outside ClaudeCord holds this chat: the composer
   *  goes read-only (typing/sending disabled, queued messages held, not
   *  drained) until it's released. Any draft text is kept. */
  lock?: ExternalLock | null
  /** The chat's folder: where / commands and @ files come from. */
  cwd?: string | null
  /** Ends the terminal holding this chat. Resolves to why it couldn't, or null. */
  /** Claude's guess at the next message: a click or Tab fills the box, never sends. */
  suggestion?: string | null
  onHijack?: () => Promise<string | null>
  /** A message starting with `!`: runs now, even during a turn, without Claude. */
  onShellCommand?: (command: string) => void
  initialDraft?: string
  onDraftChange?: (text: string) => void
  /** `text` is already fully combined (box text + any pasted chips folded
   *  in via buildOutgoingText) -- the parent just forwards it to
   *  api.send(sessionPk, text, images) verbatim. `pastedTexts` rides along
   *  for a parent that wants the raw chips (e.g. richer optimistic
   *  rendering); it's empty for a drained queue entry, since that text was
   *  already combined once at enqueue time. */
  onSend: (text: string, images: ComposerImage[], pastedTexts: PastedTextChip[]) => void
  onInterrupt: () => void
  /** Fires whenever the queued-message count changes, so a parent (App.tsx)
   *  can drive a LiveIndicator badge without owning the queue itself (the
   *  queue's add/remove/reorder state stays fully internal to Composer,
   *  same as every other in-progress compose state -- only the count is
   *  surfaced). Optional: a Composer with no listener works exactly as
   *  before. */
  onQueueLengthChange?: (count: number) => void
}) {
  const [text, setText] = useState(initialDraft ?? '')
  const [pastedChips, setPastedChips] = useState<PastedTextChip[]>([])
  const [imageChips, setImageChips] = useState<ComposerImage[]>([])
  const [queue, dispatchQueue] = useReducer(queueReducer, [] as QueuedMessage[])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  // "Hijack conversation": a second click confirms, since it ends a process.
  const [hijackConfirm, setHijackConfirm] = useState(false)
  const [hijacking, setHijacking] = useState(false)
  const [hijackError, setHijackError] = useState<string | null>(null)
  const hijackState = lock === null ? null : hijackBlock(lock)
  useEffect(() => { if (hijackState !== null) setHijackConfirm(false) }, [hijackState])
  useEffect(() => { if (lock === null) { setHijackConfirm(false); setHijackError(null) } }, [lock])
  async function hijack() {
    if (onHijack === undefined) return
    setHijacking(true)
    setHijackError(null)
    const error = await onHijack()
    setHijacking(false)
    setHijackConfirm(false)
    setHijackError(error)
    if (error === null) textareaRef.current?.focus()
  }

  // The / and @ menus. `dismissedFor` is the text Esc closed the menu on, so it
  // stays closed until the text changes.
  const [caret, setCaret] = useState(text.length)
  const [selected, setSelected] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const completion = lock === null && dismissedFor !== text ? completionAt(text, caret) : null
  const commands = useClaudeCommands(text.startsWith('/'), cwd)
  const files = useProjectFiles(completion?.kind === 'file', cwd)
  const knownCommands = useMemo(() => Array.isArray(commands) ? commands : [], [commands])
  const matches = useMemo(() => {
    if (completion === null) return { values: [] as string[], items: [] as MenuItem[], found: [] as ClaudeCommand[] }
    if (completion.kind === 'command') {
      const found = filterCommands(knownCommands, completion.query)
      return { values: found.map(c => `/${c.name}`), items: found.map(commandMenuItem), found }
    }
    const found = rankFiles(files ?? [], completion.query)
    return { values: found.map(fileMention), items: found.map(fileMenuItem), found: [] }
  }, [completion?.kind, completion?.query, knownCommands, files]) // eslint-disable-line react-hooks/exhaustive-deps
  const loading = completion !== null && (completion.kind === 'command' ? commands === 'loading' : files === null)
  const menuNote = loading ? 'Loading…' : null
  const menuOpen = completion !== null && (loading || matches.items.length > 0)
  const highlight = commandTokenLength(text, knownCommands)

  // Set once the user has arrowed to an item: Enter then always takes it.
  const navigated = useRef(false)
  useEffect(() => { setSelected(0); navigated.current = false }, [completion?.kind, completion?.query])

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [text])

  const showSuggestion = suggestion !== null && text === '' && !running && lock === null
  function useSuggestion() {
    if (suggestion === null) return
    pendingCaret.current = suggestion.length
    setCaret(suggestion.length)
    updateText(suggestion)
    textareaRef.current?.focus()
  }

  function pick(index: number) {
    const value = matches.values[index]
    if (completion === null || value === undefined) return
    const next = applyCompletion(text, completion, value)
    pendingCaret.current = next.caret
    setCaret(next.caret)
    updateText(next.text)
    textareaRef.current?.focus()
  }

  useEffect(() => {
    onQueueLengthChange?.(queue.length)
  }, [queue, onQueueLengthChange])

  // Auto-grow the textarea up to a capped height, then let it scroll.
  useEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  // Drain the queue when a turn ends: the transition from running=true to
  // running=false (not merely "is false") is what fires the next send, so a
  // component that mounts already idle with a (freshly reset, empty) queue
  // doesn't spuriously fire on mount.
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current && !running && queue.length > 0 && lock === null) {
      const next = queue[0]!
      dispatchQueue({ type: 'remove', id: next.id })
      onSend(next.text, next.images, [])
    }
    prevRunning.current = running
  }, [running, queue, onSend, lock])

  function updateText(next: string) {
    setText(next)
    onDraftChange?.(next)
  }

  function clearCompose() {
    updateText('')
    setPastedChips([])
    setImageChips([])
  }

  function addImages(images: ComposerImage[]) {
    if (images.length === 0) return
    setImageChips(prev => [...prev, ...images])
  }

  async function filesToImageChips(files: FileList | File[]): Promise<ComposerImage[]> {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return []
    const results = await Promise.all(imageFiles.map(readImageFile))
    return results.filter((img): img is ComposerImage => img !== null)
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData.files
    if (files.length > 0) {
      const hasImage = Array.from(files).some(f => f.type.startsWith('image/'))
      if (hasImage) {
        e.preventDefault()
        void filesToImageChips(files).then(addImages)
        return
      }
    }
    const pasted = e.clipboardData.getData('text/plain')
    const { isLarge, lineCount } = collapsePastedText(pasted)
    if (isLarge) {
      e.preventDefault()
      setPastedChips(prev => [...prev, { id: localId('paste'), text: pasted, lineCount }])
    }
    // Small pastes: let the browser's default paste-into-textarea behavior run.
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault()
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    void filesToImageChips(e.dataTransfer.files).then(addImages)
  }

  function attemptSend() {
    // Guard against an empty send using what would actually go out: box text
    // combined with any pasted chips (a lone image with no text still
    // counts as non-empty; nothing at all is a no-op) -- neither sent nor
    // queued.
    const wouldSend = buildOutgoingText(text, pastedChips)
    if (wouldSend.trim().length === 0 && imageChips.length === 0) return
    if (lock !== null) return
    if (onShellCommand !== undefined && wouldSend.trimStart().startsWith('!')) {
      const command = wouldSend.trimStart().slice(1).trim()
      if (command.length > 0) {
        onShellCommand(command)
        clearCompose()
      }
      return
    }
    if (running) {
      // QueuedMessage has a single `text` field with no separate pasted-chip
      // slot, so the combine has to happen now, at enqueue time.
      dispatchQueue({ type: 'add', msg: { id: localId('queued'), text: wouldSend, images: imageChips } })
    } else {
      // Not running: hand the parent the raw pieces and let it do the
      // combine (it calls buildOutgoingText(text, pastedTexts) itself before
      // api.send) -- this mirrors exactly what the drain path below does
      // with an already-combined text and an empty pastedTexts array.
      onSend(text, imageChips, pastedChips)
    }
    clearCompose()
  }

  /** Pull the most-recently queued message back into the composer (text +
   *  images), editable -- the "fast-track" first step (mirrors Claude Code's
   *  Esc-to-edit). Merges with any text already typed so nothing is lost.
   *  Returns true if something was dequeued. */
  function pullNewestQueued(): boolean {
    if (queue.length === 0) return false
    const last = queue[queue.length - 1]!
    dispatchQueue({ type: 'remove', id: last.id })
    updateText([last.text, text].map(s => s.trim()).filter(s => s.length > 0).join('\n'))
    if (last.images.length > 0) setImageChips(prev => [...last.images, ...prev])
    textareaRef.current?.focus()
    return true
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      const count = matches.items.length
      if (e.key === 'Escape') { e.preventDefault(); setDismissedFor(text); return }
      if (count > 0 && e.key === 'ArrowDown') { e.preventDefault(); navigated.current = true; setSelected(s => (s + 1) % count); return }
      if (count > 0 && e.key === 'ArrowUp') { e.preventDefault(); navigated.current = true; setSelected(s => (s - 1 + count) % count); return }
      if (count > 0 && e.key === 'Tab') { e.preventDefault(); pick(selected); return }
      // A command typed out in full sends on Enter; otherwise Enter fills it in.
      const current = matches.found[selected]
      const typedInFull = completion?.kind === 'command' && matches.values[selected] === `/${completion.query}`
      const offNameOnly = completion?.kind === 'command' && current !== undefined && !matchesCommandName(current, completion.query)
      if (count > 0 && e.key === 'Enter' && !e.shiftKey && !typedInFull && (navigated.current || !offNameOnly)) { e.preventDefault(); pick(selected); return }
    }
    if (e.key === 'Tab' && showSuggestion) { e.preventDefault(); useSuggestion(); return }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      attemptSend()
      return
    }
    if (e.key === 'Escape') {
      // Fast-track flow (matches Claude Code):
      //   1st Esc with a queued message -> pull it back into the box to edit
      //     (so it won't auto-send behind the current turn),
      //   Esc with nothing queued but a turn running -> interrupt that turn.
      // After the interrupt lands (running flips false) Enter sends immediately
      // instead of re-queueing.
      if (queue.length > 0) { e.preventDefault(); pullNewestQueued(); return }
      if (running) { e.preventDefault(); onInterrupt() }
    }
  }

  return (
    <div className="composer">
      {menuOpen && (
        <CompletionMenu label={completion.kind === 'command' ? 'Commands' : 'Files'} items={matches.items}
          selected={Math.min(selected, Math.max(matches.items.length - 1, 0))} note={menuNote}
          onPick={pick} onHover={setSelected} />
      )}
      {queue.length > 0 && (
        <ul className="composer-queue" aria-label="Queued messages">
          {queue.map((m, i) => (
            <li key={m.id} className="queue-item">
              <span className="queue-num">{i + 1}</span>
              <span className="queue-text">{m.text}</span>
              <button type="button" className="queue-btn" title="Move up" disabled={i === 0}
                onClick={() => dispatchQueue({ type: 'move', id: m.id, dir: 'up' })}>▲</button>
              <button type="button" className="queue-btn" title="Move down" disabled={i === queue.length - 1}
                onClick={() => dispatchQueue({ type: 'move', id: m.id, dir: 'down' })}>▼</button>
              <button type="button" className="queue-btn queue-remove" title="Remove"
                onClick={() => dispatchQueue({ type: 'remove', id: m.id })}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {(pastedChips.length > 0 || imageChips.length > 0) && (
        <div className="composer-chip-row">
          {pastedChips.map((c, i) => (
            <span key={c.id} className="chip">
              Pasted text #{i + 1} · {c.lineCount} lines
              <button type="button" className="chip-x" title="Remove pasted text"
                onClick={() => setPastedChips(prev => prev.filter(p => p.id !== c.id))}>✕</button>
            </span>
          ))}
          {imageChips.map(img => (
            <span key={img.id} className="chip chip-image">
              🖼 {img.name ?? 'image'}
              <button type="button" className="chip-x" title="Remove image"
                onClick={() => setImageChips(prev => prev.filter(p => p.id !== img.id))}>✕</button>
            </span>
          ))}
        </div>
      )}
      {lock !== null && (
        <div className="composer-lock" role="status">
          <span className="composer-lock-icon" aria-hidden="true">🔒</span>
          <span>
            Open in {lockHolder(lock)}{lock.status === 'busy' || lock.status === 'shell' ? ' · working' : ''} — read-only here until it exits.
            New messages from it appear live.
            {hijackConfirm && <> Hijacking closes Claude in that terminal. Anything typed there but not sent is lost.</>}
            {hijackError !== null && <span className="composer-lock-error"> {hijackError}</span>}
          </span>
          {onHijack !== undefined && hijackState !== 'not-terminal' && (
            <span className="composer-lock-actions">
              {hijackConfirm
                ? <>
                    <button type="button" className="btn-primary" disabled={hijacking} onClick={() => void hijack()}>{hijacking ? 'Hijacking…' : 'Yes, hijack'}</button>
                    <button type="button" className="btn-secondary" disabled={hijacking} onClick={() => setHijackConfirm(false)}>Cancel</button>
                  </>
                : <button type="button" className="btn-secondary" disabled={hijackState !== null}
                    title={hijackState === null ? 'Close Claude in that terminal and continue this chat here' : HIJACK_WORKING_TEXT}
                    onClick={() => { setHijackError(null); setHijackConfirm(true) }}>Hijack conversation</button>}
            </span>
          )}
        </div>
      )}
      {showSuggestion && (
        <button type="button" className="composer-suggestion" title="Tab or click to use it; it won’t send until you press Enter" onClick={useSuggestion}>
          <span aria-hidden="true">✦</span> {suggestion}
        </button>
      )}
      <div className={`composer-box${lock !== null ? ' composer-box-locked' : ''}`} onDragOver={handleDragOver} onDrop={handleDrop}>
        <div className="composer-field">
          {highlight > 0 && (
            <div ref={highlightRef} className="composer-highlight" aria-hidden="true">
              <mark>{text.slice(0, highlight)}</mark>{text.slice(highlight)}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer-input"
            placeholder={lock !== null ? 'Chat is open elsewhere' : 'Message Claude  ·  / for commands  ·  @ for files  ·  ! for a shell command'}
            disabled={lock !== null}
            value={text}
            rows={1}
            onChange={e => { setCaret(e.target.selectionStart); updateText(e.target.value) }}
            onSelect={e => setCaret(e.currentTarget.selectionStart)}
            onScroll={e => { if (highlightRef.current !== null) highlightRef.current.scrollTop = e.currentTarget.scrollTop }}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
          />
        </div>
        <button type="button" className="composer-send" title="Send" aria-label="Send message"
          disabled={lock !== null} onClick={attemptSend}>
          ➤
        </button>
      </div>
      {onShellCommand !== undefined && text.trimStart().startsWith('!') && (
        <div className="composer-hint">Runs in a shell in this folder, without Claude. Claude sees the output with your next message.</div>
      )}
      {running && (
        <div className="composer-hint" aria-hidden="true">
          {queue.length > 0
            ? 'Enter queues · Esc pulls the queued message back to edit'
            : 'Enter queues · Esc interrupts to send now'}
        </div>
      )}
    </div>
  )
}
