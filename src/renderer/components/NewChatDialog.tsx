import { useEffect, useState } from 'react'
import { api } from '../api'
import { resolveNewProjectOptions, type NewChatDefaults, type NewProjectOptions } from '../lib'
import { EFFORTS } from '../../shared/models'
import { modelOption, useClaudeModels } from './useClaudeModels'
import type { FolderContents } from '../../shared/shell-run-types'

/** Modal for starting a brand-new chat (Plan 2 Task 8): a working directory
 *  (typed, or via the native folder picker), whether to run with
 *  `--dangerously-skip-permissions`, model/effort selectors, and an optional
 *  session name -- exactly the fields the original ask called for, in that
 *  order (cwd first, skip-permissions and the rest underneath).
 *
 *  Validation/defaulting is delegated to the pure `resolveNewProjectOptions`
 *  (src/renderer/lib.ts, fully unit-tested) so this component only handles
 *  form state and wiring, not the merge/validation rules themselves.
 *
 *  REQUIRES HUMAN VERIFICATION: this component (the modal chrome, the
 *  native Browse dialog, and the end-to-end create-and-open flow) is
 *  visual/electron and cannot be exercised by vitest -- see the Task 8
 *  report for the manual check. */
export function NewChatDialog({ defaults, onCancel, onCreate, confirmBypass = false }: {
  defaults: NewChatDefaults
  /** Ask once more before creating a chat that skips permission prompts. */
  confirmBypass?: boolean
  onCancel: () => void
  /** Submits the resolved options to the engine. Resolves `{ok:true}` on
   *  success (the caller closes the dialog and opens the new chat) or
   *  `{ok:false, error}` (e.g. a cwd that doesn't exist on disk), which this
   *  component shows inline and leaves the dialog open so the user can
   *  correct it. */
  onCreate: (options: NewProjectOptions) => Promise<{ ok: true } | { ok: false; error: string }>
}) {
  const [cwd, setCwd] = useState(defaults.cwd ?? '')
  // Interactive permission approval is now wired end-to-end (Plan 3 Task 7):
  // the PermissionRelay spawns the CLI's permission MCP server via a per-session
  // pipe back to ClaudeCord's PermissionBridge + UI, verified against a live
  // `claude`. So this is a real toggle again, seeded from the persisted default.
  // OFF routes every gated tool use to a permission card; ON keeps
  // --dangerously-skip-permissions for users who want an unattended run.
  const [skipPermissions, setSkipPermissions] = useState(defaults.skipPermissions)
  const [model, setModel] = useState(defaults.model ?? '')
  const [effort, setEffort] = useState(defaults.effort ?? '')
  const [name, setName] = useState('')
  const models = useClaudeModels()
  const shownModel = model === '' ? '' : modelOption(models, model)
  const modelEfforts = models.find(m => m.value === shownModel)?.efforts ?? []
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // A folder with saved settings starts from those, since this chat will share them.
  const [fromProject, setFromProject] = useState(false)
  useEffect(() => {
    const folder = cwd.trim()
    setFromProject(false)
    if (folder.length === 0) return
    let alive = true
    const timer = setTimeout(() => {
      void api.folderSettings(folder).then(saved => {
        if (!alive || Object.keys(saved).length === 0) return
        if (saved.skipPermissions !== undefined) setSkipPermissions(saved.skipPermissions)
        if (saved.model !== undefined) setModel(saved.model)
        if (saved.effort !== undefined) setEffort(saved.effort)
        setFromProject(true)
      })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [cwd])
  // Set while asking about a folder Claude has never worked in.
  const [trustPrompt, setTrustPrompt] = useState<FolderContents | null>(null)

  async function browse() {
    const picked = await api.pickDirectory()
    if (picked !== null) { setCwd(picked); setTrustPrompt(null) }
  }

  async function submit() {
    const resolved = resolveNewProjectOptions(
      {
        cwd,
        skipPermissions,
        model: model === '' ? undefined : model,
        effort: effort === '' ? undefined : effort,
        name: name === '' ? undefined : name
      },
      defaults
    )
    if (!resolved.ok) { setError(resolved.error); return }
    if (trustPrompt !== null) {
      await api.trustFolder(resolved.options.cwd)
      setTrustPrompt(null)
    } else {
      const trust = await api.folderTrust(resolved.options.cwd)
      if (!trust.trusted) { setError(null); setTrustPrompt(trust.contents); return }
    }
    if (resolved.options.skipPermissions && confirmBypass && !confirming) { setConfirming(true); return }

    setCreating(true)
    setError(null)
    try {
      const result = await onCreate(resolved.options)
      if (!result.ok) setError(result.error)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New chat"
        onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">New chat</h2>

        <label className="field">
          <span className="field-label">Working directory</span>
          <div className="field-row">
            <input className="field-input" type="text" value={cwd} placeholder="C:\path\to\project"
              onChange={e => { setCwd(e.target.value); setTrustPrompt(null) }} />
            <button type="button" className="btn-secondary" onClick={() => void browse()}>Browse…</button>
          </div>
        </label>

        {fromProject && <p className="field-note">Using this project’s saved settings. Changes here apply to all its chats.</p>}

        <label className="field field-checkbox">
          <input type="checkbox" checked={skipPermissions} onChange={e => { setSkipPermissions(e.target.checked); setConfirming(false) }} />
          <span>Run with --dangerously-skip-permissions</span>
        </label>
        <p className="field-note">
          {skipPermissions
            ? 'Every tool runs without asking — fastest for an unattended run, but Claude can edit files and run commands unprompted.'
            : 'You’ll be asked to Allow or Deny each tool use that needs permission.'}
        </p>

        <label className="field">
          <span className="field-label">Model</span>
          <select className="field-input" value={shownModel} onChange={e => setModel(e.target.value)}>
            <option value="">Default</option>
            {models.map(m => <option key={m.value} value={m.value} title={m.description}>{m.label}</option>)}
            {shownModel !== '' && !models.some(m => m.value === shownModel) && <option value={shownModel}>{shownModel}</option>}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Effort</span>
          <select className="field-input" value={effort} onChange={e => setEffort(e.target.value)}>
            <option value="">Default</option>
            {(modelEfforts.length > 0 ? modelEfforts : EFFORTS).map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Name (optional)</span>
          <input className="field-input" type="text" value={name} placeholder="Session name"
            onChange={e => setName(e.target.value)} />
        </label>

        {error !== null && <div className="modal-error">{error}</div>}
        {trustPrompt !== null && <TrustPrompt contents={trustPrompt} skipPermissions={skipPermissions} />}
        {confirming && (
          <div className="modal-error" role="alert">
            This chat will run every tool without asking, including editing files and running commands. Create it anyway?
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={creating}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void submit()}
            disabled={cwd.trim().length === 0 || creating}>
            {creating ? 'Creating…' : trustPrompt !== null ? 'Trust folder and create' : confirming ? 'Yes, create it' : 'Create chat'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Stands in for Claude Code's own trust prompt, which ClaudeCord's chats skip. */
function TrustPrompt({ contents, skipPermissions }: { contents: FolderContents; skipPermissions: boolean }) {
  const found = [
    contents.hooks.length > 0 && `hooks that run commands (${contents.hooks.join(', ')})`,
    contents.mcpServers.length > 0 && `MCP servers it can start (${contents.mcpServers.join(', ')})`,
    contents.settings && 'its own Claude Code settings',
    contents.instructions && 'instructions for Claude (CLAUDE.md)',
    contents.extensions && 'its own skills, commands or agents'
  ].filter((x): x is string => x !== false)
  return (
    <div className="modal-error trust-prompt" role="alert">
      <strong>Do you trust the files in this folder?</strong>
      <p>Claude hasn’t worked here before. Only continue if you created this project or trust where it came from: its files can change what Claude does.</p>
      {found.length > 0 && <>
        <p>This folder includes:</p>
        <ul>{found.map(f => <li key={f}>{f}</li>)}</ul>
      </>}
      {skipPermissions && <p>This chat also skips permission prompts, so nothing will ask before Claude acts on those files.</p>}
    </div>
  )
}
