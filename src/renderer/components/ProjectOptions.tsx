import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings } from '../../shared/shell-types'
import type { ProjectSettings, ThinkingDisplay, ToolDisplay } from '../../shared/project-options'
import type { SessionSummary } from '../../shared/types'

const TOOL_LABEL: Record<string, string> = { grouped: 'Grouped', all: 'Show all', hidden: 'Hide' }

/** Everything about the open chat and its project that doesn't need to sit in the header:
 *  mode, model, effort and cost, and the choices Settings leaves to
 *  "Choose per project". */
export function ProjectOptions({ settings, chat, onChange, onOpenSettings, session, sessions, onOpenChat, onFork, summary, children }: {
  settings: AppSettings
  chat: ProjectSettings
  onChange: (patch: Partial<ProjectSettings>) => void
  onOpenSettings: () => void
  session: SessionSummary
  /** Every chat in this project, to go between them. */
  sessions: SessionSummary[]
  onOpenChat: (chat: SessionSummary) => void
  onFork: () => void
  /** Mode and model, on hover, since they're out of sight until this opens. */
  summary: string
  /** Mode, model, effort and cost. */
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const tools = settings.toolDisplay === 'perProject'
  const thoughts = settings.thinkingDisplay === 'perProject'
  const suggestions = settings.promptSuggestions === 'perProject'

  return (
    <div className="project-options" ref={rootRef}>
      <button type="button" className="chead-term" aria-expanded={open} title={summary} onClick={() => setOpen(o => !o)}>Project options</button>
      {/* Stays mounted while closed: mode and model follow the running chat from in here. */}
      <div className="mcp-pop project-options-pop" role="dialog" aria-label="Project options" hidden={!open}>
          {children}
          <button type="button" className="project-options-link" onClick={() => { setOpen(false); onFork() }}>Fork this chat, to try something else from here</button>
          {sessions.length > 1 && (
            <div className="project-chats">
              <div className="project-option"><span>Chats here</span></div>
              {sessions.slice(0, 30).map(s => (
                <button type="button" key={s.id} className={`project-chat${s.id === session.id ? ' current' : ''}`} title={s.title ?? ''}
                  onClick={() => { setOpen(false); onOpenChat(s) }}>{s.title ?? 'Untitled chat'}</button>
              ))}
            </div>
          )}
          {tools ? (
            <label className="project-option">
              <span>Tool calls</span>
              <select value={chat.toolDisplay ?? 'grouped'} onChange={e => onChange({ toolDisplay: e.target.value as ToolDisplay })}>
                <option value="grouped">Grouped</option>
                <option value="all">Show all</option>
                <option value="hidden">Hide</option>
              </select>
            </label>
          ) : (
            <div className="project-option"><span>Tool calls</span><span className="project-option-fixed">{TOOL_LABEL[settings.toolDisplay] ?? ''}</span></div>
          )}
          {thoughts ? (
            <label className="project-option">
              <span>Claude's thoughts</span>
              <select value={chat.thinkingDisplay ?? 'show'} onChange={e => onChange({ thinkingDisplay: e.target.value as ThinkingDisplay })}>
                <option value="show">Show</option>
                <option value="hidden">Hide</option>
              </select>
            </label>
          ) : (
            <div className="project-option"><span>Claude's thoughts</span><span className="project-option-fixed">{settings.thinkingDisplay === 'hidden' ? 'Hide' : 'Show'}</span></div>
          )}
          {suggestions ? (
            <label className="project-option">
              <span>Prompt suggestions</span>
              <input type="checkbox" checked={chat.promptSuggestions === true} onChange={e => onChange({ promptSuggestions: e.target.checked })} />
            </label>
          ) : (
            <div className="project-option"><span>Prompt suggestions</span><span className="project-option-fixed">{settings.promptSuggestions === 'on' ? 'On' : 'Off'}</span></div>
          )}
          {/* Added with /add-dir. The way back out is here, so one is never stuck on. */}
          {(chat.extraDirs ?? []).length > 0 && <div className="project-dirs">
            <div className="project-option"><span>Other folders Claude can use</span></div>
            {(chat.extraDirs ?? []).map(dir => (
              <div className="project-dir" key={dir}>
                <span title={dir}>{dir}</span>
                <button type="button" className="term-prompt-x" aria-label={`Remove ${dir}`}
                  onClick={() => onChange({ extraDirs: (chat.extraDirs ?? []).filter(d => d !== dir) })}>✕</button>
              </div>
            ))}
          </div>}
          {(!tools || !thoughts || !suggestions) && (
            <button type="button" className="project-options-link" onClick={() => { setOpen(false); onOpenSettings() }}>
              Set for all projects. To choose here, pick "Choose per project" in Settings
            </button>
          )}
      </div>
    </div>
  )
}
