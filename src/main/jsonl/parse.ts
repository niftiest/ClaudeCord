import type { ContentBlock, MessageRow, RawRow } from './rows'
import { displayText } from './synthetic'
export type { ContentBlock, MessageRow, RawRow, OtherRow, Usage } from './rows'

export function parseLine(line: string): RawRow | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.type !== 'string') return null
  return row as RawRow
}

export function isMessageRow(row: RawRow): row is MessageRow {
  if (row.type !== 'user' && row.type !== 'assistant') return false
  const record = row as Record<string, unknown>
  const message = record.message
  const parentUuid = record.parentUuid

  // Validate uuid
  if (typeof record.uuid !== 'string') return false

  // Validate parentUuid: must be string or exactly null
  if (typeof parentUuid !== 'string' && parentUuid !== null) return false

  // Validate message: must be non-null object and not an array
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false

  // Validate message.role
  if (typeof (message as Record<string, unknown>).role !== 'string') return false

  return true
}

/** Normalizes raw message.content into ContentBlocks: a bare string
 *  collapses to a single text block; an array keeps only well-formed
 *  tagged-object blocks; anything else yields no blocks. */
export function blocksFromContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(
    (b): b is ContentBlock => typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).type === 'string'
  )
}

export function blocksOf(row: MessageRow): ContentBlock[] {
  return blocksFromContent(row.message.content)
}

/** The row's human-readable text: what previews, titles and search index. Empty
 *  for the CLI's hidden rows; command echoes read as the command that was typed. */
export function textOf(row: MessageRow): string {
  return blocksOf(row)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => displayText(row, b.text))
    .join('\n')
    .trim()
}

/** A `system` row carrying a local command's echo or output (`/context`, a
 *  refused `/export`): the only non-message row the transcript displays. */
export type LocalCommandRow = { type: 'system'; subtype: 'local_command'; uuid: string; content: string; timestamp?: string }

function isLocalCommandRow(row: RawRow): row is RawRow & LocalCommandRow {
  const r = row as Record<string, unknown>
  return r.type === 'system' && r.subtype === 'local_command' && typeof r.uuid === 'string' && typeof r.content === 'string'
}

/** Every row the transcript can show. */
export function isDisplayRow(row: RawRow): row is MessageRow | (RawRow & LocalCommandRow) {
  return isMessageRow(row) || isLocalCommandRow(row)
}
