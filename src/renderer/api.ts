import type { ClaudeCordApi } from '../shared/ipc'
import type { EngineApi } from '../shared/engine-ipc-contract'
import type { ManageApi } from '../shared/manage-types'
import type { UpdateApi } from '../shared/update-types'
import type { ClaudeSettingsApi } from '../shared/claude-settings-types'
import type { SyncApi } from '../shared/sync-types'

declare global {
  interface Window { claudecord: ClaudeCordApi & EngineApi & ManageApi & UpdateApi & ClaudeSettingsApi & SyncApi }
}

// Thin passthrough -- the preload already exposes the full ClaudeCordApi +
// EngineApi surface on window.claudecord (src/preload/index.ts); this module
// just gives the renderer a typed, single import site for it. No IPC
// contract changes here, only the renderer-side type widened to match what
// preload already sends across the bridge.
export const api: ClaudeCordApi & EngineApi & ManageApi & UpdateApi & ClaudeSettingsApi & SyncApi = window.claudecord
