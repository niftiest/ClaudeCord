import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Catalog } from '../catalog/db'

/** Naming a chat, branching one off, and recalling what was typed. Node-only. */

/** Claude Code's own record of a chat's name. */
export function titleRow(sessionId: string, title: string): string {
  return `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`
}

export function replaceSessionId(line: string, from: string, to: string): string {
  return line.split(`"sessionId":"${from}"`).join(`"sessionId":"${to}"`).split(`"session_id":"${from}"`).join(`"session_id":"${to}"`)
}

/** Copies a chat under a new id, with what it keeps beside it, so it can go its own way. */
export async function forkTranscript(file: string, sessionId: string, newId: string, title: string): Promise<string> {
  const target = join(dirname(file), `${newId}.jsonl`)
  const text = await fsp.readFile(file, 'utf8')
  // A line the process is still writing isn't finished, so it stays behind.
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)
  await fsp.writeFile(target, `${replaceSessionId(whole, sessionId, newId)}${titleRow(newId, title)}`, 'utf8')
  await fsp.cp(join(dirname(file), sessionId), join(dirname(file), newId), { recursive: true }).catch(() => { /* nothing beside it */ })
  return target
}

const HISTORY_LIMIT = 500

/** Text Claude Code stores as the user's that nobody typed. */
const NOT_TYPED = ['<', '[Request interrupted by user', 'Base directory for this skill:', 'This session is being continued from a previous conversation', 'Caveat:']

/** What was typed in this chat's project, newest first, each once: Up and Ctrl+R in the box. */
export function promptHistory(db: Catalog, sessionPk: number): string[] {
  const rows = db.prepare(`
    SELECT m.text FROM messages m
    JOIN sessions s ON s.id = m.session_pk
    WHERE s.project_id = (SELECT project_id FROM sessions WHERE id = ?)
      AND s.kind = 'main' AND m.role = 'user' AND m.is_sidechain = 0 AND m.text IS NOT NULL AND m.text <> ''
    ORDER BY m.ts DESC, m.seq DESC
    LIMIT 5000
  `).all(sessionPk) as Array<{ text: string }>
  const seen = new Set<string>()
  const out: string[] = []
  for (const { text } of rows) {
    const t = text.trim()
    if (t.length === 0 || seen.has(t) || NOT_TYPED.some(start => t.startsWith(start))) continue
    seen.add(t)
    out.push(t)
    if (out.length >= HISTORY_LIMIT) break
  }
  return out
}
