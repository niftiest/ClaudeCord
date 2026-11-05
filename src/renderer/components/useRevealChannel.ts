import { useEffect, type RefObject } from 'react'
import { centeredScrollTop } from '../lib'

/** Scrolls a project list so this project sits in the middle, then says it's done, so going
 *  back and forth between the chat list and the icon rail later doesn't do it again. Waits two
 *  frames: the project's section may be opening in the same update. */
export function useRevealChannel(listRef: RefObject<HTMLElement | null>, reveal: number | null, onRevealed?: () => void): void {
  useEffect(() => {
    if (reveal === null) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const list = listRef.current
        const item = list?.querySelector<HTMLElement>(`[data-channel="${reveal}"]`)
        if (list !== null && list !== undefined && item !== null && item !== undefined) {
          const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
          list.scrollTop = centeredScrollTop(top, item.offsetHeight, list.clientHeight, list.scrollHeight)
        }
        onRevealed?.()
      })
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [reveal])
}
