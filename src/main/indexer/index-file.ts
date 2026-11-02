import type { Catalog } from '../catalog/db'
import { upsertProject, setProjectCwd, upsertSession } from '../catalog/repos'
import { streamRows } from '../jsonl/stream'
import { isMessageRow, blocksOf, textOf } from '../jsonl/parse'
import type { MessageRow } from '../jsonl/rows'
import type { DiscoveredFile } from './discover'

export type IndexFileResult = { sessionPk: number; added: number; skipped: boolean }

type SessionState = {
  indexed_offset: number; indexed_seq: number; file_size: number; file_mtime_ms: number
}

function toolNamesOf(row: MessageRow): string | null {
  const names = blocksOf(row)
    .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
    .map(b => b.name)
  return names.length > 0 ? names.join(',') : null
}

export async function indexFile(db: Catalog, file: DiscoveredFile): Promise<IndexFileResult> {
  const projectId = upsertProject(db, file.projectDir)
  const sessionPk = upsertSession(db, {
    projectId,
    sessionId: file.sessionId,
    kind: file.kind,
    filePath: file.filePath,
    fileSize: file.size,
    fileMtimeMs: file.mtimeMs,
    ...(file.kind === 'subagent'
      ? {
          agentId: file.agentId,
          toolUseId: file.meta?.toolUseId,
          agentType: file.meta?.agentType,
          agentDesc: file.meta?.description
        }
      : {})
  })

  const state = db.prepare(
    'SELECT indexed_offset, indexed_seq, file_size, file_mtime_ms FROM sessions WHERE id = ?'
  ).get(sessionPk) as SessionState

  // upsertSession has already written the new size/mtime for this pass, so the
  // skip check cannot compare stored size against current size -- they are
  // already equal by construction. Compare the previously-indexed offset
  // against the current file size instead: offset === size (and > 0) means
  // fully indexed already; offset === 0 covers both "never indexed" and an
  // empty file, neither of which should report skipped.
  //
  // A stale offset *past* the current end of file means the transcript was
  // rewritten rather than appended to (e.g. compaction) -- trusting it would
  // make streamRows seek past real content, silently miss rows, and leave
  // messages in the catalog that the file no longer has. Detect that here;
  // the actual reset is applied later inside the same transaction as the
  // rebuild (see below) so a failed re-stream can never leave the session
  // wiped with nothing re-inserted in its place.
  const rewritten = state.indexed_offset > file.size
  const fromOffset = rewritten ? 0 : state.indexed_offset
  const fromSeq = rewritten ? 0 : state.indexed_seq

  if (!rewritten && fromOffset > 0 && fromOffset === file.size) {
    return { sessionPk, added: 0, skipped: true }
  }

  const { rows, endOffset, seqEnd } = await streamRows(file.filePath, fromOffset, fromSeq)

  const insert = db.prepare(`
    INSERT INTO messages (session_pk, uuid, parent_uuid, seq, role, is_sidechain, ts, model, byte_offset, text, tool_names)
    VALUES (@sessionPk, @uuid, @parentUuid, @seq, @role, @isSidechain, @ts, @model, @byteOffset, @text, @toolNames)
    ON CONFLICT(session_pk, uuid) DO NOTHING
  `)

  let added = 0
  let cwd: string | null = null
  let gitBranch: string | null = null
  let model: string | null = null
  let title: string | null = null
  let firstTs: string | null = null
  let lastTs: string | null = null
  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0

  const write = db.transaction(() => {
    // Apply the rewritten-file reset atomically with the rebuild that follows:
    // drop the stale messages and the aggregates rolled up from them (token
    // totals, title, model, branch, timestamps), since re-streaming from 0
    // rebuilds all of it and a leftover aggregate would double-count on
    // re-add. Doing this inside the same transaction as the inserts below
    // means a mid-write failure rolls back to the pre-reset state instead of
    // committing an emptied-out session with nothing re-inserted.
    if (rewritten) {
      db.prepare('DELETE FROM messages WHERE session_pk = ?').run(sessionPk)
      db.prepare(`
        UPDATE sessions SET
          indexed_offset = 0, indexed_seq = 0, message_count = 0,
          first_ts = NULL, last_ts = NULL, title = NULL, model = NULL, git_branch = NULL,
          input_tokens = 0, output_tokens = 0, cache_read = 0, cache_write = 0
        WHERE id = ?
      `).run(sessionPk)
    }

    for (const { row, byteOffset, seq } of rows) {
      if (!isMessageRow(row)) continue
      const text = textOf(row)
      const info = insert.run({
        sessionPk, uuid: row.uuid, parentUuid: row.parentUuid ?? null, seq,
        role: row.type, isSidechain: row.isSidechain === true ? 1 : 0,
        ts: row.timestamp ?? null, model: row.message.model ?? null,
        byteOffset, text, toolNames: toolNamesOf(row)
      })
      // ON CONFLICT DO NOTHING leaves `changes` at 0 for a duplicate uuid
      // (e.g. a pass that re-reads rows already in the catalog). Only count
      // the row and roll its usage into the session totals when it was
      // actually inserted, or a duplicate pass would double-count tokens.
      if (info.changes === 0) continue
      added++

      if (cwd === null && typeof row.cwd === 'string') cwd = row.cwd
      if (gitBranch === null && typeof row.gitBranch === 'string') gitBranch = row.gitBranch
      if (model === null && typeof row.message.model === 'string') model = row.message.model
      if (title === null && row.type === 'user' && text.length > 0) title = text.slice(0, 120)
      if (typeof row.timestamp === 'string') {
        if (firstTs === null) firstTs = row.timestamp
        lastTs = row.timestamp
      }
      const usage = row.message.usage
      if (usage !== undefined) {
        inputTokens += usage.input_tokens ?? 0
        outputTokens += usage.output_tokens ?? 0
        cacheRead += usage.cache_read_input_tokens ?? 0
        cacheWrite += usage.cache_creation_input_tokens ?? 0
      }
    }

    db.prepare(`
      UPDATE sessions SET
        indexed_offset = ?, indexed_seq = ?,
        message_count = (SELECT COUNT(*) FROM messages WHERE session_pk = ?),
        first_ts = COALESCE(first_ts, ?), last_ts = COALESCE(?, last_ts),
        title = COALESCE(title, ?), model = COALESCE(?, model), git_branch = COALESCE(git_branch, ?),
        input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
        cache_read = cache_read + ?, cache_write = cache_write + ?
      WHERE id = ?
    `).run(endOffset, seqEnd, sessionPk, firstTs, lastTs, title, model, gitBranch,
           inputTokens, outputTokens, cacheRead, cacheWrite, sessionPk)

    if (cwd !== null) setProjectCwd(db, projectId, cwd)
    db.prepare('UPDATE projects SET last_activity = MAX(COALESCE(last_activity, \'\'), ?) WHERE id = ?')
      .run(lastTs ?? '', projectId)
  })

  write()
  return { sessionPk, added, skipped: false }
}
