import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { imageSourceUrl } from '../lib'

/** An image in a chat: a thumbnail that opens up to 80% of the window. Claude Code
 *  stores images in the transcript, so old chats show theirs too. */
export function ChatImage({ source }: { source: unknown }) {
  const [open, setOpen] = useState(false)
  const url = imageSourceUrl(source)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (url === null) return <div className="chat-image-missing">🖼 Image not available</div>
  return (
    <>
      <button type="button" className="chat-image" title="View full size" aria-label="View image full size" onClick={() => setOpen(true)}>
        <img src={url} alt="" />
      </button>
      {open && createPortal(
        <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image" onClick={() => setOpen(false)}>
          <img src={url} alt="" />
        </div>,
        document.body
      )}
    </>
  )
}
