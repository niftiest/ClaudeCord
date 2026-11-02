import { useEffect, useState } from 'react'
import { elapsedLabel, tokenLabel } from '../lib'

/** The line under a chat while Claude works, like the terminal's spinner. The word
 *  is ClaudeCord's own: Claude Code picks its words inside the terminal and doesn't
 *  send them. The time, tokens and current tool are real. */
const VERBS = [
  'Pondering', 'Tinkering', 'Noodling', 'Scheming', 'Percolating', 'Rummaging', 'Conjuring', 'Whirring',
  'Mulling', 'Puzzling', 'Crunching', 'Untangling', 'Hatching', 'Brewing', 'Wrangling', 'Sleuthing',
  'Fiddling', 'Simmering', 'Spelunking', 'Marinating', 'Cogitating', 'Doodling', 'Unravelling', 'Beavering'
]

export function pickVerb(seed: number): string {
  return VERBS[Math.abs(Math.floor(seed)) % VERBS.length]!
}

export function WorkingLine({ startedAt, tokens, tool, status, waitingOnYou }: {
  startedAt: number
  tokens: number
  /** The tool it used last, if any. */
  tool: string | null
  status: string | null
  waitingOnYou: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const label = waitingOnYou ? 'Waiting for your answer'
    : status === 'compacting' ? 'Compacting conversation'
    : pickVerb(startedAt)
  const details = [
    !waitingOnYou && status === null ? tool : null,
    elapsedLabel(now - startedAt),
    tokens > 0 ? `↓ ${tokenLabel(tokens)} tokens` : null
  ].filter((d): d is string => d !== null)
  return (
    <div className="working-line" role="status">
      <span className="working-star" aria-hidden="true">✻</span> {label}… <span className="working-details">({details.join(' · ')})</span>
    </div>
  )
}
