import type { Usage } from '../../shared/types'
import type { BackgroundTask, LiveEvent } from '../../shared/engine-types'
import { blocksFromContent } from '../jsonl/parse'
import { parseMcpServers } from './mcp-status'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Usage's fields are all optional numbers; keep only the ones that are
 *  actually numbers rather than trusting the object shape wholesale. */
function extractUsage(raw: unknown): Usage | undefined {
  if (!isPlainObject(raw)) return undefined
  const usage: Usage = {}
  if (typeof raw.input_tokens === 'number') usage.input_tokens = raw.input_tokens
  if (typeof raw.output_tokens === 'number') usage.output_tokens = raw.output_tokens
  if (typeof raw.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = raw.cache_read_input_tokens
  if (typeof raw.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = raw.cache_creation_input_tokens
  return usage
}

/** Claude Code sends its whole list each time it changes. Start times are the pool's to add. */
function parseBackgroundTasks(raw: unknown): BackgroundTask[] {
  if (!Array.isArray(raw)) return []
  const tasks: BackgroundTask[] = []
  for (const t of raw) {
    if (!isPlainObject(t) || typeof t.task_id !== 'string') continue
    tasks.push({
      id: t.task_id,
      type: typeof t.task_type === 'string' ? t.task_type : 'task',
      description: typeof t.description === 'string' ? t.description : '',
      agent: typeof t.subagent_type === 'string' ? t.subagent_type : null,
      startedAt: 0,
      lastTool: null,
      tokens: null
    })
  }
  return tasks
}

function parseSystem(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'system' }
  if (row.subtype === 'status') return { kind: 'status', status: typeof row.status === 'string' ? row.status : null }
  if (row.subtype === 'background_tasks_changed') return { kind: 'background', tasks: parseBackgroundTasks(row.tasks) }
  if (row.subtype === 'task_progress' && typeof row.task_id === 'string') {
    const tokens = isPlainObject(row.usage) && typeof row.usage.total_tokens === 'number' ? row.usage.total_tokens : null
    return { kind: 'taskProgress', taskId: row.task_id, lastTool: typeof row.last_tool_name === 'string' ? row.last_tool_name : null, tokens }
  }
  if (row.subtype !== 'init') return other
  const sessionId = row.session_id
  const cwd = row.cwd
  const model = row.model
  const permissionMode = row.permissionMode
  if (typeof sessionId !== 'string' || sessionId.length === 0) return other
  if (typeof cwd !== 'string') return other
  if (typeof model !== 'string') return other
  if (typeof permissionMode !== 'string') return other
  const init: LiveEvent = { kind: 'init', sessionId, cwd, model, permissionMode }
  const mcpServers = parseMcpServers(row.mcp_servers)
  return mcpServers.length > 0 ? { ...init, mcpServers } : init
}

function parseAssistant(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'assistant' }
  const uuid = row.uuid
  if (typeof uuid !== 'string' || uuid.length === 0) return other
  const message = row.message
  if (!isPlainObject(message)) return other

  const blocks = blocksFromContent(message.content)
  const usage = extractUsage(message.usage)
  return usage === undefined ? { kind: 'assistant', uuid, blocks } : { kind: 'assistant', uuid, blocks, usage }
}

function parseStreamEvent(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'stream_event' }
  const inner = row.event
  if (!isPlainObject(inner)) return other
  if (inner.type === 'message_delta' && isPlainObject(inner.usage) && typeof inner.usage.output_tokens === 'number') {
    return { kind: 'usage', outputTokens: inner.usage.output_tokens }
  }
  if (inner.type !== 'content_block_delta') return other
  const delta = inner.delta
  if (!isPlainObject(delta)) return other
  if (delta.type !== 'text_delta') return other
  const text = delta.text
  if (typeof text !== 'string') return other
  return { kind: 'delta', text }
}

function parseRateLimit(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'rate_limit_event' }
  const info = row.rate_limit_info
  if (!isPlainObject(info)) return other
  const status = info.status
  if (typeof status !== 'string') return other
  const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null
  return { kind: 'rate_limit', status, resetsAt }
}

function parseResult(row: Record<string, unknown>): LiveEvent {
  const isError = row.is_error === true
  const costUsd = typeof row.total_cost_usd === 'number' ? row.total_cost_usd : 0
  const text = typeof row.result === 'string' ? row.result : ''
  return { kind: 'result', isError, costUsd, text }
}

export type ControlResponse =
  | { requestId: string; ok: true; response: unknown }
  | { requestId: string; ok: false; error: string }

/** The answer to a control request we sent, or null for any other line. */
export function parseControlResponse(line: string): ControlResponse | null {
  if (!line.includes('control_response')) return null
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!isPlainObject(value) || value.type !== 'control_response' || !isPlainObject(value.response)) return null
  const r = value.response
  if (typeof r.request_id !== 'string') return null
  if (r.subtype === 'success') return { requestId: r.request_id, ok: true, response: r.response }
  return { requestId: r.request_id, ok: false, error: typeof r.error === 'string' ? r.error : 'Claude Code refused the request.' }
}

/** Tolerant, never-throwing parse of one stream-json stdout line into a
 *  typed LiveEvent. Mirrors jsonl/parse.ts's parseLine: blank, non-JSON,
 *  non-object, or type-less lines all yield null. Every field narrowed off
 *  the parsed JSON is validated before being trusted. */
export function parseEvent(line: string): LiveEvent | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isPlainObject(value)) return null
  const type = value.type
  if (typeof type !== 'string') return null

  // A subagent's own messages and tokens share this stream. It reports through its
  // task; showing them as Claude's would put its words in the chat's reply.
  if ((type === 'assistant' || type === 'stream_event') && typeof value.parent_tool_use_id === 'string') return { kind: 'other', type }

  switch (type) {
    case 'system':
      return parseSystem(value)
    case 'assistant':
      return parseAssistant(value)
    case 'stream_event':
      return parseStreamEvent(value)
    case 'rate_limit_event':
      return parseRateLimit(value)
    case 'result':
      return parseResult(value)
    case 'prompt_suggestion':
      return typeof value.suggestion === 'string' && value.suggestion.trim().length > 0
        ? { kind: 'suggestion', text: value.suggestion.trim() }
        : { kind: 'other', type }
    default:
      return { kind: 'other', type }
  }
}
