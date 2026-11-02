import { useEffect, useState } from 'react'
import { modelOption, useClaudeModels } from './useClaudeModels'
import { api } from '../api'
import type { SessionSummary } from '../../shared/types'
import { EFFORTS, costOfSession, formatCost } from '../../shared/models'

/** The model / effort / cost strip in the chat header (above the transcript).
 *  Model and effort are live overrides -- changing either pushes the choice to
 *  the engine (`api.setSessionOverrides`), which applies it on the session's
 *  NEXT turn (a spawned `claude` can't switch model mid-flight). The cost chip
 *  is a read-only list-price estimate of the tokens the session has already
 *  spent, at the model those tokens were charged against (`session.model`).
 *
 *  Mounted with `key={session.id}` by the parent so its local override state
 *  resets cleanly when the user switches chats -- the seed below only runs on
 *  first mount per session.
 *
 *  REQUIRES HUMAN VERIFICATION: renders live in Electron; the selectors and
 *  the engine round-trip aren't exercised by vitest (the cost math and model
 *  list are, in tests/models.test.ts). */
export function ChatHeaderControls({ session, liveModel }: {
  session: SessionSummary
  /** The model the chat's process says it's on, which /model can change. */
  liveModel: string | null
}) {
  const models = useClaudeModels()
  // Seed the model select from whatever the session was last recorded running.
  // The catalog stores a resolved id (e.g. 'claude-opus-4-8'); if that isn't
  // one of our alias options it simply shows as "Default" until the user picks,
  // which is fine -- picking is what sends an override anyway.
  // "<synthetic>" marks rows Claude Code wrote itself: it isn't a model anyone can pick.
  const [model, setModel] = useState(session.model === null || session.model === '<synthetic>' ? '' : session.model)
  const [effort, setEffort] = useState('')
  // What this project chose before, which every chat in it shares.
  useEffect(() => {
    void api.getProjectSettings(session.id).then(c => {
      if (c.model !== undefined) setModel(c.model)
      if (c.effort !== undefined) setEffort(c.effort)
    })
  }, [session.id])
  useEffect(() => { if (liveModel !== null) setModel(liveModel) }, [liveModel])

  function changeModel(value: string) {
    setModel(value)
    // Empty string means "leave at the engine default" -- the main handler
    // drops empty fields, so this is a no-op override rather than a clobber.
    api.setSessionOverrides(session.id, { model: value })
  }
  function changeEffort(value: string) {
    setEffort(value)
    api.setSessionOverrides(session.id, { effort: value })
  }

  const cost = costOfSession(session.model, {
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheRead: session.cacheRead,
    cacheWrite: session.cacheWrite
  })

  // A model set to a resolved id we don't list still needs to be selectable
  // (so the <select> shows the right current value rather than snapping to
  // Default); surface it as an extra option when it isn't already one of ours.
  const shown = model === '' ? '' : modelOption(models, model)
  const hasModel = shown === '' || models.some(m => m.value === shown)
  const efforts = models.find(m => m.value === shown)?.efforts ?? []
  const effortOptions: readonly string[] = efforts.length > 0 ? efforts : EFFORTS

  return (
    <div className="chead-controls">
      <label className="chead-control">
        <span className="chead-control-label">Model</span>
        <select className="chead-select" value={shown} onChange={e => changeModel(e.target.value)}
          title="Model for the next turn">
          <option value="">Default</option>
          {models.map(m => <option key={m.value} value={m.value} title={m.description}>{m.label}</option>)}
          {!hasModel && <option value={shown}>{shown}</option>}
        </select>
      </label>
      <label className="chead-control">
        <span className="chead-control-label">Effort</span>
        <select className="chead-select" value={effort} onChange={e => changeEffort(e.target.value)}
          title="Reasoning effort for the next turn">
          <option value="">Default</option>
          {effortOptions.map(v => <option key={v} value={v}>{v}</option>)}
          {effort !== '' && !effortOptions.includes(effort) && <option value={effort}>{effort}</option>}
        </select>
      </label>
      <span className="chead-cost" title="Estimated list-price cost of this chat's token usage">
        {formatCost(cost)}
      </span>
    </div>
  )
}
