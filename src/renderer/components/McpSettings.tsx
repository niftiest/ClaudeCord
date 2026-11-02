import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { McpServerInfo } from '../../shared/ipc'
import type { McpServerStatus } from '../../shared/claude-info-types'
import { mcpProblems, mcpStatusLabel } from '../lib'

/** Settings → MCP servers: every server Claude Code would use for this folder,
 *  and how each one is doing right now, as Claude itself reports it. Falls back
 *  to the config files if Claude can't be asked. */
export function McpSettings({ projectCwd, ignored, onIgnoredChange }: {
  projectCwd: string | null
  ignored: string[]
  onIgnoredChange: (next: string[]) => void
}) {
  const [servers, setServers] = useState<McpServerStatus[] | null>(null)
  const [fallback, setFallback] = useState<{ error: string; servers: McpServerInfo[] } | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)

  const check = useCallback(() => {
    setServers(null)
    setFallback(null)
    void api.mcpCheck(projectCwd).then(async r => {
      if (r.ok) { setServers(r.servers); return }
      setFallback({ error: r.error, servers: await api.listMcpServers(projectCwd) })
    })
  }, [projectCwd])
  useEffect(check, [check])

  async function signIn(name: string) {
    setLoginError(null)
    const r = await api.mcpLogin(projectCwd, name)
    if (!r.ok) setLoginError(`${name}: ${r.error}`)
  }

  if (fallback !== null) {
    return <>
      <div className="cc-warn">Couldn’t ask Claude Code how these are doing ({fallback.error}). Showing what’s in your config files, without live status.</div>
      <div className="ms-list">
        {fallback.servers.map(s => (
          <div key={`${s.scope}:${s.name}`} className="ms-item">
            <div className="ms-item-head">
              <span className="ms-name">{s.name}</span>
              <span className="ms-badge">{s.transport}</span>
              <span className={`ms-scope ms-scope-${s.scope}`}>{s.scope}</span>
            </div>
            {s.detail && <div className="ms-detail">{s.detail}</div>}
          </div>
        ))}
      </div>
      <button type="button" className="btn-secondary" onClick={check}>Check again</button>
    </>
  }
  if (servers === null) return <p className="settings-note">Starting your MCP servers to see how they’re doing. This can take up to 20 seconds…</p>

  const problemNames = new Set(mcpProblems(servers, []).map(s => s.name))
  const sorted = [...servers].sort((a, b) => Number(problemNames.has(b.name)) - Number(problemNames.has(a.name)) || a.name.localeCompare(b.name))

  return <>
    <div className="cc-actions">
      <span className="settings-note" style={{ margin: 0 }}>{servers.length} configured{projectCwd !== null ? ' for this project' : ''}. A chat warns you if one it needs is down.</span>
      <button type="button" className="btn-secondary" onClick={check}>Check again</button>
    </div>
    {loginError !== null && <div className="cc-err">{loginError}</div>}
    {sorted.length === 0 && <p className="settings-note">No MCP servers configured.</p>}
    <div className="ms-list">
      {sorted.map(s => (
        <div key={s.name} className="ms-item">
          <div className="ms-item-head">
            <span className="ms-name">{s.name}</span>
            {s.transport !== null && <span className="ms-badge">{s.transport}</span>}
            <span className={`mcp-status mcp-status-${s.status}`}>{mcpStatusLabel(s.status)}</span>
            {s.status === 'connected' && <span className="ms-detail" style={{ margin: 0 }} title={s.tools.join(', ')}>{s.tools.length} tool{s.tools.length === 1 ? '' : 's'}</span>}
            <span className="mcp-item-actions">
              {s.status === 'needs-auth' && <button type="button" className="btn-secondary" onClick={() => void signIn(s.name)}>Sign in…</button>}
              {problemNames.has(s.name) && (
                <label className="mcp-warn-toggle">
                  <input type="checkbox" checked={!ignored.includes(s.name)}
                    onChange={e => onIgnoredChange(e.target.checked ? ignored.filter(n => n !== s.name) : [...ignored, s.name])} />
                  Warn in chats
                </label>
              )}
            </span>
          </div>
          {s.error !== null && <div className="mcp-pop-error">{s.error}</div>}
          {s.detail !== '' && <div className="ms-detail">{s.detail}</div>}
        </div>
      ))}
    </div>
    <p className="settings-note">Add or remove servers with <code>claude mcp</code> or your config files. Turn a project’s own servers on or off under Settings → Claude Code.</p>
  </>
}
