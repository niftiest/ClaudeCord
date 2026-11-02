import { APP_THEMES, type AppTheme, type AppThemeScope } from '../shared/shell-types'

// The persisted source of truth is the `theme` / `themeScope` settings
// (settings_kv). This localStorage copy only exists so the theme can be applied
// synchronously before React's first paint, while the settings IPC is in flight.
const CACHE_KEY = 'claudecord.theme'
const SCOPE_KEY = 'claudecord.themeScope'

export type ThemeChoice = { theme: AppTheme; scope: AppThemeScope }

/** Colours the sidebars as well as the chat, so scope doesn't apply to it. */
function isWholeWindow(theme: AppTheme): boolean {
  return theme === 'midnight'
}

/** The theme attribute for the page root: the skin covers the whole window only
 *  in 'app' scope; in 'chat' scope the root keeps the default Discord look and
 *  the chat pane carries the attribute itself (see chatPaneTheme). */
export function rootTheme(c: ThemeChoice): AppTheme {
  return c.scope === 'app' || isWholeWindow(c.theme) ? c.theme : 'discord'
}

/** The `data-theme` for the chat pane (`<main>`) -- styles.css scopes the
 *  terminal skin to any ancestor with `[data-theme="terminal"]`, so putting it
 *  on <main> restyles just the header, transcript and composer. */
export function chatPaneTheme(c: ThemeChoice): AppTheme | undefined {
  return c.theme === 'discord' || isWholeWindow(c.theme) ? undefined : c.theme
}

/** Apply to `<html data-theme>` and remember for the next launch's first paint. */
export function applyTheme(c: ThemeChoice): void {
  document.documentElement.dataset.theme = rootTheme(c)
  try {
    localStorage.setItem(CACHE_KEY, c.theme)
    localStorage.setItem(SCOPE_KEY, c.scope)
  } catch { /* storage unavailable: first paint just uses the default */ }
}

/** The last-used choice (defaults when nothing is cached). */
export function cachedTheme(): ThemeChoice {
  let theme: string | null = null
  let scope: string | null = null
  try {
    theme = localStorage.getItem(CACHE_KEY)
    scope = localStorage.getItem(SCOPE_KEY)
  } catch { /* ignore */ }
  return { theme: APP_THEMES.find(t => t === theme) ?? 'discord', scope: scope === 'app' ? 'app' : 'chat' }
}

/** Apply the last-used theme before render (called once from main.tsx). */
export function applyCachedTheme(): void {
  document.documentElement.dataset.theme = rootTheme(cachedTheme())
}
