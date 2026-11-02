import { describe, it, expect } from 'vitest'
import { chatPaneTheme, rootTheme } from '../src/renderer/theme'
import { DEFAULT_SETTINGS } from '../src/main/catalog/settings'
import { APP_THEMES } from '../src/shared/shell-types'

describe('themes', () => {
  it('Midnight always colours the whole window, whatever the scope', () => {
    for (const scope of ['chat', 'app'] as const) {
      expect(rootTheme({ theme: 'midnight', scope })).toBe('midnight')
      expect(chatPaneTheme({ theme: 'midnight', scope })).toBeUndefined()
    }
  })

  it('Terminal still honours its scope', () => {
    expect(rootTheme({ theme: 'terminal', scope: 'chat' })).toBe('discord')
    expect(chatPaneTheme({ theme: 'terminal', scope: 'chat' })).toBe('terminal')
    expect(rootTheme({ theme: 'terminal', scope: 'app' })).toBe('terminal')
  })

  it('Midnight is a valid choice, and not the default', () => {
    expect(APP_THEMES).toContain('midnight')
    expect(DEFAULT_SETTINGS.theme).toBe('discord')
  })
})
