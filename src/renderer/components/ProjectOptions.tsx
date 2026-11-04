import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../shared/shell-types'
import type { ProjectSettings, ToolDisplay } from '../../shared/project-options'
import type { SessionSummary } from '../../shared/types'

const TOOL_LABEL: Record<string, string> = { grouped: 'Grouped', all: 'Show all', hidden: 'Hide' }

/** This project's own choices, for the options Settings leaves to "Choose per project". */
export function ProjectOptions({ settings, chat, onChange, onAddDir, onOpenSettings, session, sessions, onOpenChat, onRename, onFork }: {
  settings: AppSettings
  chat: ProjectSettings
  onChange: (patch: Partial<ProjectSettings>) => void
  onAddDir: () => void
  onOpenSettings: () => void
  session: SessionSummary
  /** Every chat in this project, to go between them. */
  sessions: SessionSummary[]
  onOpenChat: (chat: SessionSummary) => void
  onRename: (title: string) => void
  onFork: () => void
}) {
  const [name, setName] = useState(session.title ?? '')
  useEffect(() => { setName(session.title ?? '') }, [session.id, session.title])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const tools = settings.toolDisplay === 'perProject'
  const suggestions = settings.promptSuggestions === 'perProject'

  return (
    <div className="project-options" ref={rootRef}>
      <button type="button" className="chead-term" aria-expanded={open} title="Options for this project, shared by all its chats" onClick={() => setOpen(o => !o)}>Project options</button>
      {open && (
        <div className="mcp-pop project-options-pop" role="dialog" aria-label="Project options">
          <label className="project-option project-option-name">
            <span>This chat's name</span>
            <input type="text" value={name} onChange={e => setName(e.target.value)} aria-label="This chat's name"
              onKeyDown={e => { if (e.key === 'Enter' && name.trim().length > 0) { onRename(name); setOpen(false) } }}
              onBlur={() => { if (name.trim().length > 0 && name.trim() !== (session.title ?? '')) onRename(name) }} />
          </label>
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
          {suggestions ? (
            <label className="project-option">
              <span>Prompt suggestions</span>
              <input type="checkbox" checked={chat.promptSuggestions === true} onChange={e => onChange({ promptSuggestions: e.target.checked })} />
            </label>
          ) : (
            <div className="project-option"><span>Prompt suggestions</span><span className="project-option-fixed">{settings.promptSuggestions === 'on' ? 'On' : 'Off'}</span></div>
          )}
          <div className="project-dirs">
            <div className="project-option"><span>Other folders Claude can use</span></div>
            {(chat.extraDirs ?? []).map(dir => (
              <div className="project-dir" key={dir}>
                <span title={dir}>{dir}</span>
                <button type="button" className="term-prompt-x" aria-label={`Remove ${dir}`}
                  onClick={() => onChange({ extraDirs: (chat.extraDirs ?? []).filter(d => d !== dir) })}>✕</button>
              </div>
            ))}
            <button type="button" className="project-options-link" onClick={onAddDir}>Add a folder…</button>
          </div>
          {(!tools || !suggestions) && (
            <button type="button" className="project-options-link" onClick={() => { setOpen(false); onOpenSettings() }}>
              Set for all projects. To choose here, pick "Choose per project" in Settings
            </button>
          )}
        </div>
      )}
    </div>
  )
}
