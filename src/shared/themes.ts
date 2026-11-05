import type { AppSettings, AppTheme } from './shell-types'

/** What a saved theme holds: how the app looks. Text sizes stay out: they suit the person and
 *  their screen, whatever the theme. So do prompt suggestions, which spend tokens, so a theme,
 *  and above all someone else's theme file, can't turn them on. */
export const THEME_KEYS = [
  'theme', 'themeScope', 'appFont', 'navDensity', 'density',
  'claudeIcon', 'toolDisplay', 'thinkingDisplay', 'showBlade', 'showContextRail', 'thinkingExpanded', 'toolCardsExpanded'
] as const satisfies ReadonlyArray<keyof AppSettings>

export type ThemeKey = typeof THEME_KEYS[number]
export type ThemeValues = Partial<Pick<AppSettings, ThemeKey>>
export type CustomTheme = { name: string; values: ThemeValues }

export const BUILT_IN_THEMES: ReadonlyArray<{ id: AppTheme; label: string }> = [
  { id: 'discord', label: 'Discord (default)' },
  { id: 'terminal', label: 'Terminal (Claude Code)' },
  { id: 'midnight', label: 'Midnight (darker)' }
]

export const THEME_FILE_EXTENSION = 'claudecord-theme'
export const MAX_THEME_NAME = 60
/** A theme is settings and at most one small avatar. */
export const MAX_THEME_FILE_BYTES = 1024 * 1024

export type SaveThemeResult =
  | { ok: true; settings: AppSettings; themes: CustomTheme[]; name: string }
  | { ok: false; reason: 'name' | 'builtin' | 'cancelled'; message?: string }

export type ImportThemeResult =
  | { status: 'cancelled' }
  | { status: 'invalid'; message: string }
  | { status: 'ready'; name: string; values: ThemeValues; conflict: 'none' | 'custom' | 'builtin' }

export type ExportThemeResult =
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }
  | { status: 'saved'; path: string }

/** A usable name, tidied, or null. */
export function cleanThemeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return name.length === 0 || name.length > MAX_THEME_NAME ? null : name
}

export function sameThemeName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Both what a built-in is called in the list and its short name are taken. */
export function isBuiltInThemeName(name: string): boolean {
  return BUILT_IN_THEMES.some(t => sameThemeName(name, t.id) || sameThemeName(name, t.label))
}

export function themeValuesOf(settings: AppSettings): ThemeValues {
  const out: Record<string, unknown> = {}
  for (const key of THEME_KEYS) out[key] = settings[key]
  return out as ThemeValues
}

/** Whether the settings have moved away from the theme they came from. Only what the theme
 *  holds counts: an older file may not hold every setting. */
export function themeIsModified(settings: AppSettings, theme: CustomTheme): boolean {
  return THEME_KEYS.some(key => key in theme.values && JSON.stringify(theme.values[key]) !== JSON.stringify(settings[key]))
}

export function activeCustomTheme(settings: AppSettings, themes: CustomTheme[]): CustomTheme | null {
  const name = settings.activeTheme
  return name === null ? null : themes.find(t => sameThemeName(t.name, name)) ?? null
}

/** A theme's name as a file name Windows will take. */
export function themeFileName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'theme'
  return `${safe}.${THEME_FILE_EXTENSION}`
}

/** A theme's name from the file name the user picked. */
export function themeNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(new RegExp(`\\.(${THEME_FILE_EXTENSION}|json)$`, 'i'), '')
}
