import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../shared/shell-types'
import type { ProjectSettings, ToolDisplay } from '../../shared/project-options'

const TOOL_LABEL: Record<string, string> = { grouped: 'Grouped', all: 'Show all', hidden: 'Hide' }

/** This project's own choices, for the options Settings leaves to "Choose per project". */
export function ProjectOptions({ settings, chat, onChange, onOpenSettings }: {
  settings: AppSettings
  chat: ProjectSettings
  onChange: (patch: Partial<ProjectSettings>) => void
  onOpenSettings: () => void
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
  const suggestions = settings.promptSuggestions === 'perProject'

  return (
    <div className="project-options" ref={rootRef}>
      <button type="button" className="chead-term" aria-expanded={open} title="Options for this project, shared by all its chats" onClick={() => setOpen(o => !o)}>Project options</button>
      {open && (
        <div className="mcp-pop project-options-pop" role="dialog" aria-label="Project options">
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
