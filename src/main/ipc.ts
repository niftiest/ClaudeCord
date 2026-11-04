import { ipcMain, app, shell, type BrowserWindow } from 'electron'
import { applyStartupSettings, relaunchElevated, isElevated } from './elevation'
import type { Catalog } from './catalog/db'
import { listProjects, listSubagents, sumTotalCostUsd } from './catalog/repos'
import { backupCatalogOnce, chatsToShow, folderGone, isConversationText, moveCustomisations } from './catalog/archive'
import { displayText } from './jsonl/synthetic'
import { readOriginRepo } from './engine/github'
import { search, searchProject } from './catalog/search'
import { getSettings, updateSettings } from './catalog/settings'
import type { AppSettings } from '../shared/shell-types'
import {
  getChannelMeta, setFriendlyName, setStarred, setChannelIcon, setChannelGroup,
  listGroups, createGroup, renameGroup, deleteGroup, setHidden, setGroupIcon
} from './catalog/metadata'
import { deleteChannel } from './delete-channel'
import { listMcpServers, listSkills } from './mcp-skills'
import { readFsTree } from './fs-tree'
import { listProjectFiles } from './project-files'
import { generateAvatar, fetchImageModels, fetchUsage } from './openrouter'
import { saveImage } from './save-image'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runIndex } from './indexer/indexer'
import { syncSessionIfStale } from './engine/external-sync'
import { streamRange } from './jsonl/stream'
import { isDisplayRow, type LocalCommandRow } from './jsonl/parse'
import { buildRenderItems } from './jsonl/render'
import type { MessageRow } from './jsonl/rows'
import type { TranscriptPage, ChannelRow, IndexProgress, RenderItem } from '../shared/types'
import type { ChannelIcon } from '../shared/shell-types'
import { IPC } from '../shared/ipc'
import { launchExePath } from './portable-update'

/** Messages per page. Scrolling up requests the previous page. */
export const PAGE_SIZE = 60
/** Rows read past a page's end so a boundary tool_use finds its tool_result. */
const LOOKAHEAD_ROWS = 5
const JUMP_CONTEXT_ROWS = 10

type NodeRow = { uuid: string; seq: number }

/** A chat whose transcript has gone, from the text the catalog saved of it. Tool calls and
 *  their output weren't saved. Null when there's no text to show. */
function savedTextPage(db: Catalog, sessionPk: number, window: string[], oldestSeq: number, hasMore: boolean): TranscriptPage | null {
  const wanted = new Set(window)
  const rows = db.prepare(
    'SELECT uuid, role, ts, model, text FROM messages WHERE session_pk = ? AND is_sidechain = 0 AND seq >= ? ORDER BY seq'
  ).all(sessionPk, oldestSeq) as Array<{ uuid: string; role: string; ts: string | null; model: string | null; text: string | null }>
  const items: RenderItem[] = []
  for (const row of rows) {
    if (!wanted.has(row.uuid) || !isConversationText(row.text) || (row.role !== 'user' && row.role !== 'assistant')) continue
    const text = displayText({}, row.text)
    if (text.length > 0) items.push({ kind: 'text', uuid: row.uuid, role: row.role, ts: row.ts, model: row.model, text })
  }
  // Older pages may still have some, even if this one is all tool calls.
  if (items.length === 0 && !hasMore) return null
  return { items, oldestSeq, hasMore, savedTextOnly: true }
}

export async function loadTranscript(
  db: Catalog,
  sessionPk: number,
  opts: { before?: number; limit?: number; fromSeq?: number } = {}
): Promise<TranscriptPage> {
  const empty: TranscriptPage = { items: [], oldestSeq: null, hasMore: false }

  const session = db.prepare('SELECT file_path FROM sessions WHERE id = ?').get(sessionPk) as
    | { file_path: string }
    | undefined
  if (session === undefined) return empty

  // A chat-history viewer shows EVERY message in chronological order (like
  // Discord), not a pruned "live branch". Earlier this walked the parentUuid
  // tree to drop abandoned rewind branches — but that truncated real sessions
  // catastrophically, for two reasons proven against live data:
  //   1. parentUuid threads through NON-message rows (attachment, summary,
  //      file-history-snapshot, system, …) which aren't in this message-only
  //      projection, so the walk hit a "dangling" parent and stopped — leaving
  //      only the last unbroken message-to-message run (e.g. 6 of 4,520).
  //   2. Long sessions are compacted/resumed over days, producing MULTIPLE
  //      parentUuid roots (a forest); a walk from the newest leaf can never
  //      reach earlier segments anyway.
  // So we render all message rows in seq (write) order and window over them.
  // Sidechain rows stay excluded — subagent traffic belongs nested in its Task
  // card, not inline in the main timeline.
  const nodes = db.prepare(
    'SELECT uuid, seq FROM messages WHERE session_pk = ? AND is_sidechain = 0 ORDER BY seq'
  ).all(sessionPk) as NodeRow[]
  if (nodes.length === 0) return empty

  const seqOf = new Map(nodes.map(n => [n.uuid, n.seq]))
  const livePath = nodes.map(n => n.uuid)                 // uuids, oldest -> newest (chronological)

  const eligible = opts.before === undefined
    ? livePath
    : livePath.filter(uuid => (seqOf.get(uuid) ?? -1) < opts.before!)
  if (eligible.length === 0) return empty

  // A caller-supplied limit of 0 or negative would otherwise slice an empty
  // (or backwards) window; clamp to at least one message per page.
  const limit = Math.max(1, opts.limit ?? PAGE_SIZE)
  // Going to a message: everything from it on, so the view stays one unbroken run,
  // plus a few before it to read it in context.
  const target = opts.fromSeq === undefined ? -1 : eligible.findIndex(uuid => (seqOf.get(uuid) ?? -1) >= opts.fromSeq!)
  const windowStart = target === -1
    ? Math.max(0, eligible.length - limit)
    : Math.min(Math.max(0, target - JUMP_CONTEXT_ROWS), Math.max(0, eligible.length - limit))
  const window = eligible.slice(windowStart)
  const windowSet = new Set(window)

  const firstSeq = seqOf.get(window[0]!)!
  const lastSeq = seqOf.get(window[window.length - 1]!)!

  const start = db.prepare(
    'SELECT byte_offset AS o FROM messages WHERE session_pk = ? AND seq = ?'
  ).get(sessionPk, firstSeq) as { o: number } | undefined
  if (start === undefined) return empty

  // Read to just before the first row beyond the lookahead window; if there is
  // none, read to end of file.
  //
  // `seq` is assigned to every parsed JSONL line (streamRows), not just
  // message rows -- non-message rows (file-history-snapshot, summary,
  // attachment, ...) consume seq slots but never reach this table, so seq is
  // NOT message-contiguous. Doing arithmetic on it (seq > lastSeq + N) counts
  // line-space, not message-space: a run of non-message rows longer than
  // LOOKAHEAD_ROWS would push the next real message's seq past the threshold
  // and exclude it -- dropping the boundary tool_result the lookahead exists
  // to include. Walking the ordered message rows with OFFSET instead counts
  // actual message rows, so the result is exactly LOOKAHEAD_ROWS messages of
  // lookahead regardless of how many non-message rows are interleaved.
  const stop = db.prepare(
    `SELECT byte_offset AS o FROM messages
     WHERE session_pk = ? AND seq > ?
     ORDER BY seq
     LIMIT 1 OFFSET ?`
  ).get(sessionPk, lastSeq, LOOKAHEAD_ROWS) as { o: number } | undefined
  const toOffset = stop === undefined ? undefined : stop.o - 1

  // The catalog can outlive the transcript file (moved, pruned, on a
  // disconnected drive); a page load must degrade to "nothing to show"
  // rather than crash the whole IPC round trip. But only a genuinely
  // missing file justifies that: swallowing every error here would also
  // hide a real corruption (streamRange rejects with a MAX_LINE_BYTES
  // error on an oversized line) behind an indistinguishable empty page.
  let messages: Array<MessageRow | LocalCommandRow>
  try {
    const { rows } = await streamRange(session.file_path, start.o, toOffset)
    messages = []
    for (const { row } of rows) if (isDisplayRow(row)) messages.push(row)
  } catch (err) {
    // The catalog knew about messages (nodes were found above) but the JSONL is
    // gone -- almost always Claude Code's cleanupPeriodDays pruning an old chat.
    // Flag it so the UI shows an "archived / removed from disk" state rather
    // than an empty "no messages" one.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return savedTextPage(db, sessionPk, window, firstSeq, eligible.length > window.length) ?? { ...empty, fileMissing: true }
    throw err
  }

  return {
    items: buildRenderItems(messages, windowSet),
    oldestSeq: firstSeq,
    hasMore: eligible.length > window.length
  }
}

/** Merges each project row with its app-owned ChannelMeta (Plan 3 Task 2) --
 *  the nav's actual data source. One `getChannelMeta` SELECT per channel
 *  rather than a bulk `allChannelMeta` map lookup: simpler, and the nav's
 *  channel count is small (one row per ~/.claude project directory) so the
 *  extra queries are not a real cost. `getChannelMeta` already returns sane
 *  defaults for a channel with no metadata row yet, so every project always
 *  gets a `meta`, never undefined. */
export function listChannels(db: Catalog): ChannelRow[] {
  return listProjects(db).flatMap((p): ChannelRow[] => {
    const meta = getChannelMeta(db, p.dirName)
    if (!folderGone(p.cwd)) return [{ ...p, meta, repo: p.cwd !== null && p.cwd.length > 0 ? readOriginRepo(p.cwd) : null }]
    // Every chat here moved with the project, so this row has nothing of its own to show.
    const chats = chatsToShow(db, p.id).length
    if (p.sessionCount > 0 && chats === 0) return []
    return [{ ...p, sessionCount: chats, meta, repo: null, archived: true }]
  })
}

/** One-time seed of secrets from a git-ignored `local-secrets.json` at the
 *  project root (dev convenience): if it carries an `openRouterKey` and the
 *  stored setting is still empty, persist it. Keeps a live API key OUT of the
 *  committed source while still pre-filling it on this machine. Best-effort --
 *  a missing/malformed file is silently ignored. */
function seedLocalSecrets(db: Catalog): void {
  try {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'local-secrets.json'), 'utf8')) as { openRouterKey?: unknown }
    const key = typeof parsed.openRouterKey === 'string' ? parsed.openRouterKey : ''
    if (key.length > 0 && getSettings(db).openRouterKey.length === 0) updateSettings(db, { openRouterKey: key })
  } catch { /* no local-secrets.json -- nothing to seed */ }
}

export type IpcHooks = {
  /** Mirrors startup index progress somewhere besides the main window (the
   *  launch splash, while the main window is still hidden). */
  onIndexProgress?: (p: IndexProgress) => void
  /** Settings were saved (tray options may have changed). */
  onSettingsChanged?: (s: AppSettings) => void
}

/** Startup registrations launch ClaudeCord with this, so "Start minimised"
 *  applies to a login start, not to the user opening the app themselves. */
export const AUTOSTART_ARG = '--autostart'

export function registerIpc(db: Catalog, window: BrowserWindow, hooks: IpcHooks = {}): void {
  seedLocalSecrets(db)
  ipcMain.handle(IPC.listProjects, () => listProjects(db))
  ipcMain.handle(IPC.listSessions, (_e, projectId: number) => chatsToShow(db, projectId))
  ipcMain.handle(IPC.loadTranscript, (_e, sessionPk: number, opts?: { before?: number; limit?: number; fromSeq?: number }) =>
    loadTranscript(db, sessionPk, opts))
  ipcMain.handle(IPC.syncSessionIfStale, (_e, sessionPk: number) => syncSessionIfStale(db, sessionPk))
  ipcMain.handle(IPC.listSubagents, (_e, toolUseId: string) => listSubagents(db, toolUseId))
  ipcMain.handle(IPC.search, (_e, query: string) => search(db, query))
  ipcMain.handle(IPC.searchProject, (_e, projectId: number, query: string) => searchProject(db, projectId, query))
  ipcMain.handle(IPC.indexRun, async () => {
    await runIndex(db, {
      onProgress: p => {
        if (!window.isDestroyed()) window.webContents.send(IPC.indexProgress, p)
        hooks.onIndexProgress?.(p)
      }
    })
  })

  ipcMain.handle(IPC.listChannels, () => {
    if (db.name !== ':memory:') {
      try {
        moveCustomisations(db, () => backupCatalogOnce(db, join(dirname(db.name), 'catalog-before-archive.db')))
      } catch (err) {
        // Without its backup nothing moves. The nav still has to load.
        console.warn('[archive] could not move a project\'s star and name', err)
      }
    }
    return listChannels(db)
  })
  ipcMain.handle(IPC.totalCost, () => sumTotalCostUsd(db))
  ipcMain.handle(IPC.listGroups, () => listGroups(db))
  ipcMain.handle(IPC.setFriendlyName, (_e, dirName: string, name: string | null) => setFriendlyName(db, dirName, name))
  ipcMain.handle(IPC.setStarred, (_e, dirName: string, starred: boolean) => setStarred(db, dirName, starred))
  ipcMain.handle(IPC.setChannelIcon, (_e, dirName: string, icon: ChannelIcon) => setChannelIcon(db, dirName, icon))
  ipcMain.handle(IPC.setChannelGroup, (_e, dirName: string, groupId: number | null) => setChannelGroup(db, dirName, groupId))
  ipcMain.handle(IPC.createGroup, (_e, name: string) => createGroup(db, name))
  ipcMain.handle(IPC.renameGroup, (_e, id: number, name: string) => renameGroup(db, id, name))
  ipcMain.handle(IPC.setGroupIcon, (_e, id: number, icon: ChannelIcon) => setGroupIcon(db, id, icon))
  ipcMain.handle(IPC.deleteGroup, (_e, id: number) => deleteGroup(db, id))
  ipcMain.handle(IPC.setChannelHidden, (_e, dirName: string, hidden: boolean) => setHidden(db, dirName, hidden))
  ipcMain.handle(IPC.deleteChannel, (_e, dirName: string) => {
    const { deletedSessions } = deleteChannel(db, dirName)
    return { deletedSessions }
  })
  ipcMain.handle(IPC.listMcpServers, (_e, projectCwd?: string | null) =>
    listMcpServers({ homeDir: homedir(), projectCwd }))
  ipcMain.handle(IPC.listSkills, (_e, projectCwd?: string | null) =>
    listSkills({ homeDir: homedir(), projectCwd }))
  ipcMain.handle(IPC.fsTree, (_e, cwd: string | null) => readFsTree(cwd))
  ipcMain.handle(IPC.openLink, async (_e, url: string) => {
    if (typeof url === 'string' && /^(https?:\/\/|mailto:)/i.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle(IPC.listProjectFiles, (_e, cwd: string | null) => listProjectFiles(cwd))
  ipcMain.handle(IPC.generateAvatar, (_e, prompt: string, size?: string, model?: string) => {
    const s = getSettings(db)
    // A per-generation model override (from the picker) wins; else the setting.
    return generateAvatar({ apiKey: s.openRouterKey, model: model && model.length > 0 ? model : s.avatarModel, prompt, size })
  })
  ipcMain.handle(IPC.listImageModels, () => fetchImageModels())
  ipcMain.handle(IPC.openRouterUsage, () => fetchUsage(getSettings(db).openRouterKey))
  ipcMain.handle(IPC.saveImage, (_e, cwd: string, relPath: string, dataUrl: string) => saveImage({ cwd, relPath, dataUrl }))
  ipcMain.handle(IPC.getSettings, () => getSettings(db))
  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    const before = getSettings(db)
    const after = updateSettings(db, patch)
    // Reconcile OS startup registration when a startup/admin field changed.
    if (before.startWithWindows !== after.startWithWindows || before.startWithAdmin !== after.startWithAdmin) {
      applyStartupSettings({
        startWithWindows: after.startWithWindows,
        startWithAdmin: after.startWithAdmin,
        exePath: launchExePath(app.getPath('exe')),
        appArgs: [AUTOSTART_ARG]
      })
      // Newly enabling admin: relaunch elevated (one UAC prompt), then quit.
      if (after.startWithAdmin && !before.startWithAdmin && !isElevated()) {
        if (relaunchElevated(launchExePath(app.getPath('exe')))) app.quit()
      }
    }
    hooks.onSettingsChanged?.(after)
    return after
  })
  ipcMain.handle(IPC.isElevated, () => isElevated())
}
