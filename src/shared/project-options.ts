/** Options a project can have its own value for, and how they combine with Settings.
 *  A global setting of anything but "perProject" overrides every project's own choice.
 *  Electron-free: shared by the main process and the renderer. */

export type ToolDisplay = 'grouped' | 'all' | 'hidden'
export const TOOL_DISPLAYS: readonly ToolDisplay[] = ['grouped', 'all', 'hidden']
export type ToolDisplaySetting = ToolDisplay | 'perProject'
export const TOOL_DISPLAY_SETTINGS: readonly ToolDisplaySetting[] = [...TOOL_DISPLAYS, 'perProject']

export type SuggestionsSetting = 'off' | 'on' | 'perProject'
export const SUGGESTIONS_SETTINGS: readonly SuggestionsSetting[] = ['off', 'on', 'perProject']

export type ThinkingDisplay = 'show' | 'hidden'
export const THINKING_DISPLAYS: readonly ThinkingDisplay[] = ['show', 'hidden']
export type ThinkingDisplaySetting = ThinkingDisplay | 'perProject'
export const THINKING_DISPLAY_SETTINGS: readonly ThinkingDisplaySetting[] = [...THINKING_DISPLAYS, 'perProject']

/** What one project remembers, shared by every chat in its folder. */
export type ProjectSettings = {
  model?: string
  effort?: string
  skipPermissions?: boolean
  promptSuggestions?: boolean
  toolDisplay?: ToolDisplay
  thinkingDisplay?: ThinkingDisplay
  /** Whether the Files panel is open. Unset: whatever was last chosen anywhere. */
  filesExpanded?: boolean
  /** Folders outside the project that Claude may use, for every chat in it. */
  extraDirs?: string[]
}

/** With "per project" selected, a project that hasn't chosen behaves like the app's default. */
export function effectiveToolDisplay(setting: ToolDisplaySetting, project: ProjectSettings | null): ToolDisplay {
  return setting === 'perProject' ? project?.toolDisplay ?? 'grouped' : setting
}

export function effectiveThinkingDisplay(setting: ThinkingDisplaySetting, project: ProjectSettings | null): ThinkingDisplay {
  return setting === 'perProject' ? project?.thinkingDisplay ?? 'show' : setting
}

/** `claudeAllows` is false when the user's Claude Code settings turn suggestions off,
 *  which outranks everything here. */
export function suggestionsWanted(setting: SuggestionsSetting, project: ProjectSettings | null, claudeAllows: boolean): boolean {
  if (!claudeAllows) return false
  return setting === 'perProject' ? project?.promptSuggestions === true : setting === 'on'
}

export type ContextUsage = {
  usedTokens: number
  maxTokens: number
  percent: number
  /** What's taking the room, largest first. */
  categories: Array<{ name: string; tokens: number }>
}
