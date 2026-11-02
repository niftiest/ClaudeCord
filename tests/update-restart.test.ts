import { describe, expect, it } from 'vitest'
import { AWAY_SECONDS, canRestartForUpdate } from '../src/shared/update-types'

describe('canRestartForUpdate', () => {
  const clear = { autoInstall: true, ready: true, unsent: false, activeWork: 0, idleSeconds: AWAY_SECONDS }

  it('restarts when a downloaded update has nothing to interrupt', () => {
    expect(canRestartForUpdate(clear)).toBe(true)
  })

  it.each([
    ['installing automatically is off', { autoInstall: false }],
    ['nothing has downloaded', { ready: false }],
    ['a message is unsent', { unsent: true }],
    ['a chat is working', { activeWork: 1 }],
    ['someone is at the computer', { idleSeconds: AWAY_SECONDS - 1 }]
  ])('waits when %s', (_why, change) => {
    expect(canRestartForUpdate({ ...clear, ...change })).toBe(false)
  })
})
