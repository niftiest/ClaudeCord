import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { clampMenuPosition } from '../lib'
import type { TextMenuAction, TextMenuRequest } from '../../shared/text-menu'

/** The right-click menu for text, in the app's own style. Mouse presses are kept from taking
 *  the focus, since copying and replacing a word act on what's selected in the box. */
export function TextMenuHost() {
  const [menu, setMenu] = useState<TextMenuRequest | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => api.onTextMenu(setMenu), [])

  useLayoutEffect(() => {
    if (menu === null || ref.current === null) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos(clampMenuPosition(menu.x, menu.y, width, height, window.innerWidth, window.innerHeight))
  }, [menu])

  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) close() }
    // Ahead of everything else: behind this menu, Esc would stop Claude or take back a message.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('wheel', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close, true)
    }
  }, [menu])

  if (menu === null) return null
  const act = (action: TextMenuAction): void => {
    setMenu(null)
    api.textMenuAction(action)
  }
  const item = (label: string, action: TextMenuAction, enabled = true, className = ''): ReactNode => (
    <button key={label} type="button" role="menuitem" className={`ctx-item ${className}`} disabled={!enabled}
      onMouseDown={e => e.preventDefault()} onClick={() => act(action)}>{label}</button>
  )
  const spelling = menu.misspelled !== null
  const hasEditing = menu.editable || menu.canCopy
  return (
    <div ref={ref} className="ctx-menu text-menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {spelling && (
        <>
          {menu.suggestions.length === 0 && <div className="text-menu-none">No spelling suggestions</div>}
          {menu.suggestions.map(word => item(word, { kind: 'replace', word }, true, 'text-menu-word'))}
          {item('Add to dictionary', { kind: 'addWord' })}
          {(menu.linkUrl !== null || hasEditing) && <div className="ctx-sep" />}
        </>
      )}
      {menu.linkUrl !== null && item('Copy URL', { kind: 'copyLink' })}
      {menu.linkUrl !== null && hasEditing && <div className="ctx-sep" />}
      {menu.editable && item('Cut', { kind: 'cut' }, menu.canCut)}
      {hasEditing && item('Copy', { kind: 'copy' }, menu.canCopy)}
      {menu.editable && item('Paste', { kind: 'paste' }, menu.canPaste)}
    </div>
  )
}
