import { useEffect, useState } from 'react'
import { workingDetails, type PendingTool } from '../lib'

/** The line under a chat while Claude works, like the terminal's spinner. The word
 *  is ClaudeCord's own: Claude Code picks its words inside the terminal and doesn't
 *  send them. The times, tokens and running tool are real. */
const VERBS = [
  'Pondering', 'Tinkering', 'Noodling', 'Scheming', 'Percolating', 'Rummaging', 'Conjuring', 'Whirring',
  'Mulling', 'Puzzling', 'Crunching', 'Untangling', 'Hatching', 'Brewing', 'Wrangling', 'Sleuthing',
  'Fiddling', 'Simmering', 'Spelunking', 'Marinating', 'Cogitating', 'Doodling', 'Unravelling', 'Beavering'
]

export function pickVerb(seed: number): string {
  return VERBS[Math.abs(Math.floor(seed)) % VERBS.length]!
}

export function WorkingLine({ startedAt, tokens, pending, lastActivity, status, waitingOnYou }: {
  startedAt: number
  tokens: number
  /** This turn's tool calls still waiting for a result. */
  pending: PendingTool[]
  /** When Claude Code last sent anything. */
  lastActivity: number
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
  const details = workingDetails({ now, startedAt, tokens, pending, lastActivity, quiet: waitingOnYou || status !== null })
  return (
    <div className="working-line" role="status">
      <span className="working-star" aria-hidden="true">✻</span> {label}… <span className="working-details">({details.join(' · ')})</span>
    </div>
  )
}
