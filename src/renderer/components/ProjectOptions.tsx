import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../shared/shell-types'
import type { ProjectSettings, ToolDisplay } from '../../shared/project-options'

/** This project's own choices, for the options Settings leaves to "Choose per project". */
export function ProjectOptions({ settings, chat, onChange }: {
  settings: AppSettings
  chat: ProjectSettings
  onChange: (patch: Partial<ProjectSettings>) => void
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
  if (!tools && !suggestions) return null

  return (
    <div className="project-options" ref={rootRef}>
      <button type="button" className="chead-term" aria-expanded={open} title="Options for this project, shared by all its chats" onClick={() => setOpen(o => !o)}>Project options</button>
      {open && (
        <div className="mcp-pop project-options-pop" role="dialog" aria-label="Project options">
          {tools && (
            <label className="project-option">
              <span>Tool calls</span>
              <select value={chat.toolDisplay ?? 'grouped'} onChange={e => onChange({ toolDisplay: e.target.value as ToolDisplay })}>
                <option value="grouped">Grouped</option>
                <option value="all">Show all</option>
                <option value="hidden">Hide</option>
              </select>
            </label>
          )}
          {suggestions && (
            <label className="project-option">
              <span>Prompt suggestions</span>
              <input type="checkbox" checked={chat.promptSuggestions === true} onChange={e => onChange({ promptSuggestions: e.target.checked })} />
            </label>
          )}
        </div>
      )}
    </div>
  )
}
