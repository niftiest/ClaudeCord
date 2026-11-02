import type { ContentBlock, Usage } from './types'
import type { McpServerStatus } from './claude-info-types'

/** Typed view of one line of `claude ... --output-format stream-json` stdout.
 *  Produced by src/main/engine/events.ts's tolerant parseEvent(). This module
 *  must stay electron-free: it is imported by both main and renderer. */
export type LiveEvent =
  | { kind: 'init'; sessionId: string; cwd: string; model: string; permissionMode: string; mcpServers?: McpServerStatus[] }
  | { kind: 'assistant'; uuid: string; blocks: ContentBlock[]; usage?: Usage }
  | { kind: 'delta'; text: string }
  | { kind: 'result'; isError: boolean; costUsd: number; text: string }
  | { kind: 'rate_limit'; status: string; resetsAt: number | null }
  /** What the process is busy with outside a reply, e.g. 'compacting'; null when that ends. */
  | { kind: 'status'; status: string | null }
  /** Tokens one reply used, once it finishes. A turn can have several replies. */
  | { kind: 'usage'; outputTokens: number }
  /** Claude's prediction of what the user will say next. */
  | { kind: 'suggestion'; text: string }
  /** Everything running in the background now. The pool adds start times and the latest progress. */
  | { kind: 'background'; tasks: BackgroundTask[] }
  /** How one background agent is getting on. The pool folds this into `background`. */
  | { kind: 'taskProgress'; taskId: string; lastTool: string | null; tokens: number | null }
  | { kind: 'other'; type: string }
  /** Synthesized by SessionPool (never parsed off the wire -- see pool.ts's
   *  `transport.onExit` handler) the instant a transport's process exits,
   *  for ANY reason: a clean finish that already sent its own `result`, a
   *  spawn failure (bad claudeBin), an interrupt-triggered SIGINT, or a
   *  mid-turn crash. Plan 2 review Fix 1: without this, only a `result`
   *  event ever cleared the renderer's `running` flag, so any non-result
   *  termination left the UI stuck permanently "streaming". `code` mirrors
   *  Node's child_process exit code (`null` for a signal-terminated
   *  process, e.g. SIGINT or a spawn `error`). */
  | { kind: 'exit'; code: number | null }

/** One permission request the running `claude` CLI is asking about, parked by
 *  PermissionBridge (src/main/engine/permission-bridge.ts) until the renderer
 *  answers via IPC. Deliberately NOT a LiveEvent variant: every LiveEvent is
 *  fire-and-forget, but a PermissionRequest needs a reply routed back through
 *  `PermissionBridge.resolve()` before the CLI's tool call can proceed --
 *  Plan 2 Task 6 streams it on its own `engine:permission` channel instead.
 *  `tool`/`input` mirror the MCP tool-call's `tool_name`/`input` fields (see
 *  the permission-prompt contract captured from a live CLI run -- that
 *  request shape is UNDOCUMENTED upstream, so `toolUseId` stays optional). */
export type PermissionRequest = {
  id: string
  tool: string
  input: unknown
  sessionKey: string
  toolUseId?: string
}

/** The renderer's answer to a parked PermissionRequest. Mirrors the
 *  DOCUMENTED MCP tool-result contract exactly (same file as above): allow
 *  always carries `updatedInput`, defaulted to the original input by
 *  `buildPermissionResult` when the user didn't edit it (required since some
 *  CLI versions reject an allow without it); deny always carries a
 *  human-readable `message` that the CLI surfaces back to Claude.
 *  `allow_always` is NOT a decision here -- it's the app's job to also derive
 *  a persisted-rule string (`allowAlwaysRule`) alongside an ordinary `allow`. */
export type PermissionDecision = { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }

/** One live engine process for the pool HUD (engine:list). `sessionKey` is the
 *  session file path (the renderer maps it to a chat name); `state` is derived
 *  best-effort from recency + the renderer's own permission state:
 *  'spawning' (no pid yet), 'streaming' (recent activity), 'idle' (quiet). The
 *  renderer promotes a session with a pending permission request to 'blocked'. */
/** A command or agent still working after Claude's turn moved on. Claude Code picks
 *  the chat back up by itself when one finishes. */
export type BackgroundTask = {
  id: string
  /** Claude Code's task type, e.g. local_bash or local_agent. */
  type: string
  description: string
  /** Subagent type, for an agent. */
  agent: string | null
  startedAt: number
  lastTool: string | null
  tokens: number | null
}

/** The running turn as the engine pool sees it. */
export type TurnInfo = { startedAt: number; tokens: number; lastActivity: number }

export type EngineSnapshot = {
  sessionKey: string
  pid: number | null
  model: string | null
  effort: string | null
  startedAt: number
  lastActivity: number
  /** A turn is running now. False for a process kept loaded between turns. */
  busy: boolean
  /** Background tasks this process is still running. */
  background: number
}

/** A live `claude` process OUTSIDE ClaudeCord (typically a terminal) holding a
 *  chat open, from its `~/.claude/sessions/<pid>.json` lock. While present the
 *  chat is read-only in ClaudeCord: a second writer would fork the transcript. */
/** A chat a live `claude` process has under Remote Control (`/rc` or
 *  `--remote-control`): drivable from claude.ai / the Claude app. Detected from
 *  `bridgeSessionId` in its ~/.claude/sessions/<pid>.json lock. */
export type RemoteSession = { sessionPk: number; projectId: number }

export type ExternalLock = {
  pid: number
  /** 'cli' = an interactive terminal; 'sdk-cli' = another headless/SDK host. */
  entrypoint: string | null
  /** The CLI's own 'busy' | 'idle' status, when it reports one. */
  status: string | null
}
