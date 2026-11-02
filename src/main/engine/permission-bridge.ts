import type { PermissionDecision, PermissionRequest } from '../../shared/engine-types'

/** Engine core: the stdio MCP server the CLI calls (via
 *  `--permission-prompt-tool`) whenever it needs approval for a tool use in
 *  plan/acceptEdits/manual/dontAsk mode (Plan 2 Task 5). Node-only -- must
 *  never import electron; enforced by tests/architecture.test.ts the same as
 *  the rest of src/main/engine. engine-ipc.ts (Task 6) is the electron
 *  boundary that wires PermissionBridge.onRequest/resolve to the renderer.
 *
 *  Two separable concerns, deliberately kept apart so each is independently
 *  testable:
 *   (A) Pure functions -- buildPermissionResult / toMcpToolResult /
 *       parsePermissionArgs / allowAlwaysRule -- encode the documented
 *       response contract and the tolerant parse of the undocumented request
 *       shape. No state, no I/O.
 *   (B) PermissionBridge (the parking coordinator) + routeMcpRequest /
 *       McpStdioServer (the JSON-RPC-over-stdio framing). PermissionBridge
 *       has zero knowledge of JSON-RPC; McpStdioServer has zero knowledge of
 *       parking -- it just routes a parsed request object to
 *       PermissionBridge.handleToolCall and frames the reply.
 *
 *  Hand-rolled JSON-RPC instead of `@modelcontextprotocol/sdk`: the SDK isn't
 *  currently a dependency, and MCP's stdio wire format for this single-tool
 *  use case is small (newline-delimited JSON-RPC 2.0; three methods matter:
 *  initialize, tools/list, tools/call) -- pulling in a whole SDK's process
 *  lifecycle/transport abstractions would make the framing HARDER to unit
 *  test (it wants to own stdin/stdout), not easier, and this project's engine
 *  layer already favors small, injectable, hand-rolled I/O wrappers over
 *  bigger library-owned loops (see Transport's ChildLike / SessionPool's
 *  TransportFactory). `routeMcpRequest` below takes a plain parsed request
 *  object and returns a plain response object -- exactly the shape the task
 *  brief's test plan asks for, with no stdio involved at all. */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// (A) Pure functions -- the documented response contract + tolerant request
//     parsing (the request shape was captured from a live CLI run).
// ---------------------------------------------------------------------------

export type PermissionResultPayload = { behavior: string; updatedInput?: unknown; message?: string }

/** Builds the exact MCP-result JSON the CLI expects, given a decision + the
 *  original (pre-edit) tool input. DOCUMENTED contract, pinned exactly by
 *  tests -- do not "simplify" this away:
 *   - allow: ALWAYS includes `updatedInput`, defaulted to the original input
 *     when the decision didn't supply an edited one (some CLI versions
 *     reject an allow without `updatedInput` at all).
 *   - deny: `behavior` + `message` only -- no `updatedInput` field. */
export function buildPermissionResult(decision: PermissionDecision, originalInput: unknown): PermissionResultPayload {
  if (decision.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: decision.updatedInput ?? originalInput }
  }
  return { behavior: 'deny', message: decision.message }
}

/** Wraps a result payload into the MCP tool-result content shape: a single
 *  text content block whose text is the JSON-stringified payload. This is
 *  the literal thing `tools/call` must return as its `result`. */
export function toMcpToolResult(result: object): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

/** Tolerant parse of the CLI's `tools/call` arguments into a PermissionRequest.
 *  `tool_name`/`input` are solid per the SDK's `canUseTool(tool_name,
 *  input_data, context)` mirror; `tool_use_id` is likely-but-unconfirmed, so
 *  it stays optional and is omitted (not set to `undefined`) when absent.
 *  Never throws: junk/non-object args, a missing `tool_name`, or unexpected
 *  extra fields all degrade to a defensible request rather than a crash --
 *  the CLI is waiting on a reply either way, and a hard failure here would
 *  hang the whole turn. Unknown fields are intentionally NOT enumerated/
 *  logged from inside this pure function (that would make it impure and
 *  untestable-by-equality); the MCP server layer that calls this with the
 *  raw `arguments` is the right place to log the raw payload once, for the
 *  live-run confirmation Task 10 needs against the real, undocumented shape. */
export function parsePermissionArgs(args: unknown, id: string, sessionKey: string): PermissionRequest {
  const obj = isPlainObject(args) ? args : {}

  const toolName = typeof obj.tool_name === 'string' && obj.tool_name.length > 0 ? obj.tool_name : 'unknown'
  const input = 'input' in obj ? obj.input : undefined
  const toolUseId = typeof obj.tool_use_id === 'string' && obj.tool_use_id.length > 0 ? obj.tool_use_id : undefined

  const base: PermissionRequest = { id, tool: toolName, input, sessionKey }
  return toolUseId === undefined ? base : { ...base, toolUseId }
}

function firstStringField(input: unknown, keys: string[]): string | null {
  if (!isPlainObject(input)) return null
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** Bash rule heuristic: keep the command's stable prefix, wildcard the final
 *  (usually variable) token -- `"npx playwright test"` -> `"npx playwright *"`,
 *  `"npm run build"` -> `"npm run *"`. A single-token command still gets a
 *  wildcard suffix (`"ls"` -> `"ls *"`) rather than a bare-word rule, since a
 *  bare `ls` with no arguments is a degenerate case of the same pattern, not a
 *  different one. No `command` string at all -> the bare tool name, same as
 *  every other tool with nothing to scope on. */
function bashRule(input: unknown): string {
  const command = firstStringField(input, ['command'])
  if (command === null) return 'Bash'
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return 'Bash'
  if (tokens.length === 1) return `Bash(${tokens[0]} *)`
  return `Bash(${tokens.slice(0, -1).join(' ')} *)`
}

/** Derives an "allow always" rule string from a request, for the app to
 *  persist and pass on the NEXT spawn via `--allowedTools` (no documented
 *  over-the-wire field persists this from an external prompt tool -- see the
 *  contract file's "Allow-always / rules" section). This function only
 *  derives the string; actually persisting/wiring it into a future spawn is
 *  the app's job (outside this task). `Bash` gets the command-prefix
 *  heuristic above; `Read`/`Edit`/`Write` get a path-scoped rule when the
 *  input carries a path (`file_path`, matching the CLI's own tool input
 *  field, or `path` as a fallback); anything else -- including Read/Edit/
 *  Write with no discoverable path -- falls back to the bare tool name. */
export function allowAlwaysRule(tool: string, input: unknown): string {
  if (tool === 'Bash') return bashRule(input)

  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    const path = firstStringField(input, ['file_path', 'path'])
    if (path !== null) return `${tool}(${path})`
  }

  return tool
}

// ---------------------------------------------------------------------------
// (B) PermissionBridge -- the parking coordinator. Zero JSON-RPC knowledge.
// ---------------------------------------------------------------------------

/** How long a parked request waits for `resolve()` before this bridge gives
 *  up and denies it on the CLI's behalf. The SDK's own equivalent
 *  (`canUseTool`) can apparently stay pending indefinitely (per the contract
 *  file's gotchas -- undocumented), but that would let one forgotten UI
 *  prompt hang an entire turn (and the process behind it) forever. Denying
 *  after a generous wait is the safer default for an interactive app: the CLI
 *  gets an answer and can report it to the user instead of hanging silently.
 *  Generous on purpose (a human may be away from the keyboard) -- tests
 *  override this via the constructor to exercise the timeout path quickly. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

type PendingEntry = {
  resolvePromise: (result: object) => void
  originalInput: unknown
  timeoutHandle: NodeJS.Timeout | null
  settled: boolean
}

/** Parks each `tools/call` invocation as a promise keyed by a fresh id,
 *  fans the parsed request out to `onRequest` subscribers, and completes the
 *  parked promise -- with the exact MCP tool-result shape -- once `resolve()`
 *  is called (by the app, once the renderer answers) or the per-request
 *  timeout fires. Has no idea it's being driven over JSON-RPC/stdio; that
 *  wiring lives in `routeMcpRequest`/`McpStdioServer` below. */
export class PermissionBridge {
  readonly toolName: string
  private readonly timeoutMs: number

  private nextId = 0
  private readonly pending = new Map<string, PendingEntry>()
  private readonly requestListeners: Array<(req: PermissionRequest) => void> = []

  /** Set by shutdown(). Terminal, like SessionPool's `stopped`: once a bridge
   *  has been shut down, any further handleToolCall() is denied immediately
   *  instead of parking a promise that has no server left to answer it. */
  private shuttingDown = false

  constructor(opts?: { toolName?: string; timeoutMs?: number }) {
    this.toolName = opts?.toolName ?? 'approve'
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Registers a subscriber notified of every parked request (the app's IPC
   *  layer forwards these to the renderer as `engine:permission` events). */
  onRequest(cb: (req: PermissionRequest) => void): void {
    this.requestListeners.push(cb)
  }

  /** Called by the MCP server layer when a `tools/call` arrives: parses the
   *  raw arguments, parks a promise keyed by a fresh id, emits `onRequest`,
   *  and returns a promise that resolves to the MCP tool-result once
   *  `resolve()` is called for that id (or the timeout denies it first). */
  handleToolCall(args: unknown, sessionKey: string): Promise<object> {
    this.nextId += 1
    const id = `perm-${this.nextId}`
    const req = parsePermissionArgs(args, id, sessionKey)

    return new Promise<object>((resolvePromise) => {
      const entry: PendingEntry = {
        resolvePromise,
        originalInput: req.input,
        timeoutHandle: null,
        settled: false
      }

      if (this.shuttingDown) {
        this.settle(entry, { behavior: 'deny', message: 'permission bridge is shutting down' })
        return
      }

      this.pending.set(id, entry)

      if (this.timeoutMs > 0) {
        const handle = setTimeout(() => this.expireTimeout(id), this.timeoutMs)
        // Never let this timer alone keep the process alive.
        handle.unref?.()
        entry.timeoutHandle = handle
      }

      for (const cb of this.requestListeners) cb(req)
    })
  }

  /** Completes the parked promise for `id` with the given decision, wrapped
   *  in the exact MCP result shape. An unknown id -- never parked, already
   *  resolved, already timed out, or already denied by shutdown() -- is a
   *  safe no-op: this covers both "resolve after the process died" (nothing
   *  is listening to the settled promise anymore, which is harmless) and "two
   *  resolves for one id" (the first resolve already removed the entry). */
  resolve(id: string, decision: PermissionDecision): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
    this.settle(entry, buildPermissionResult(decision, entry.originalInput))
  }

  /** Denies every currently-parked request -- the app calls this when the MCP
   *  server (or the whole engine) is shutting down with requests still
   *  awaiting a UI answer, so the CLI gets a clean deny instead of the pipe
   *  just dying mid-wait. Also flips the bridge into a terminal
   *  deny-immediately state (see `shuttingDown` above) so a `handleToolCall`
   *  racing with this shutdown doesn't park a promise nothing will ever
   *  settle. Idempotent: a second call finds nothing parked. */
  shutdown(message = 'permission bridge shut down'): void {
    this.shuttingDown = true
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
      this.settle(entry, { behavior: 'deny', message })
    }
  }

  private expireTimeout(id: string): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    this.settle(entry, { behavior: 'deny', message: 'permission request timed out waiting for a decision' })
  }

  private settle(entry: PendingEntry, payload: PermissionResultPayload): void {
    if (entry.settled) return
    entry.settled = true
    entry.resolvePromise(toMcpToolResult(payload))
  }
}

// ---------------------------------------------------------------------------
// (B continued) JSON-RPC-over-stdio framing -- minimal, hand-rolled.
// ---------------------------------------------------------------------------

type JsonRpcId = string | number

export type McpJsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown }
export type McpJsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } }

const PROTOCOL_VERSION_FALLBACK = '2024-11-05'
const SERVER_INFO = { name: 'claudecord-permission-bridge', version: '0.1.0' }

function parseJsonRpcRequest(raw: unknown): McpJsonRpcRequest | null {
  if (!isPlainObject(raw)) return null
  if (raw.jsonrpc !== '2.0') return null
  const method = raw.method
  if (typeof method !== 'string') return null
  const id = raw.id
  const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params: raw.params }
  return typeof id === 'string' || typeof id === 'number' ? { ...req, id } : req
}

function errorResponse(id: JsonRpcId, code: number, message: string): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function idOf(raw: unknown): JsonRpcId | undefined {
  if (!isPlainObject(raw)) return undefined
  const id = raw.id
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

function handleInitialize(req: McpJsonRpcRequest): McpJsonRpcResponse | null {
  if (req.id === undefined) return null
  const params = isPlainObject(req.params) ? req.params : {}
  // Echo back whatever protocolVersion the client asked for -- the CLI's
  // exact expected version is unconfirmed, and echoing is the standard
  // defensive negotiation move when a fixed constant risks a mismatch.
  const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION_FALLBACK
  return {
    jsonrpc: '2.0',
    id: req.id,
    result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO }
  }
}

function handleToolsList(req: McpJsonRpcRequest, bridge: PermissionBridge): McpJsonRpcResponse | null {
  if (req.id === undefined) return null
  return {
    jsonrpc: '2.0',
    id: req.id,
    result: {
      tools: [
        {
          name: bridge.toolName,
          description: 'Approve or deny a tool call requested by Claude Code.',
          // Deliberately permissive -- the request's own `input` shape varies
          // per tool and is parsed tolerantly by parsePermissionArgs anyway.
          inputSchema: { type: 'object', properties: {}, additionalProperties: true }
        }
      ]
    }
  }
}

async function handleToolsCall(req: McpJsonRpcRequest, bridge: PermissionBridge, sessionKey: string): Promise<McpJsonRpcResponse | null> {
  const params = isPlainObject(req.params) ? req.params : {}
  // Tolerant: accept the spec's `{ name, arguments }` shape but fall back to
  // treating the whole params object as the arguments if `arguments` is
  // absent, rather than failing a call whose shape drifts slightly.
  const args = 'arguments' in params ? params.arguments : params
  const result = await bridge.handleToolCall(args, sessionKey)
  if (req.id === undefined) return null
  return { jsonrpc: '2.0', id: req.id, result }
}

/** Routes one already-JSON-parsed MCP JSON-RPC message to the right handler
 *  and returns the response to send back -- or `null` when no response is
 *  expected (a notification, i.e. no `id`). Pure with respect to I/O: it
 *  takes a plain object in and returns a plain object (or null) out, so a
 *  recorded `tools/call` request can be fed straight through in a test
 *  without any stdio involved at all. Never throws: a malformed message that
 *  still carries an id gets a JSON-RPC error response; one with no id (or not
 *  even an object) is silently dropped, matching JSON-RPC's own rule that
 *  notifications get no reply. */
export function routeMcpRequest(raw: unknown, bridge: PermissionBridge, sessionKey: string): Promise<McpJsonRpcResponse | null> {
  const req = parseJsonRpcRequest(raw)
  if (req === null) {
    const id = idOf(raw)
    return Promise.resolve(id === undefined ? null : errorResponse(id, -32600, 'invalid request'))
  }

  switch (req.method) {
    case 'initialize':
      return Promise.resolve(handleInitialize(req))
    case 'notifications/initialized':
      return Promise.resolve(null)
    case 'tools/list':
      return Promise.resolve(handleToolsList(req, bridge))
    case 'tools/call':
      return handleToolsCall(req, bridge, sessionKey)
    case 'ping':
      return Promise.resolve(req.id === undefined ? null : { jsonrpc: '2.0', id: req.id, result: {} })
    default:
      return Promise.resolve(req.id === undefined ? null : errorResponse(req.id, -32601, `method not found: ${req.method}`))
  }
}

const NEWLINE = 0x0a

export interface StdioLike {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}

/** The actual stdio transport: reads newline-delimited JSON-RPC requests from
 *  `input`, routes each through `routeMcpRequest`, and writes each non-null
 *  response back to `output` as one JSON line. Byte-safe line framing (same
 *  discipline as Transport's stdout handling in transport.ts) -- a request
 *  split across chunks is only parsed once its newline arrives. Injectable
 *  streams (defaulting to `process.stdin`/`process.stdout`) so this can be
 *  driven by a PassThrough pair in tests instead of real OS pipes; this is
 *  also what makes the CLI's up-to-30s startup handshake safe -- `initialize`
 *  is answered synchronously off `routeMcpRequest`, no slow setup in between. */
export class McpStdioServer {
  private readonly bridge: PermissionBridge
  private readonly sessionKey: string
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream

  private pendingBytes: Buffer = Buffer.alloc(0)
  private stopped = false

  constructor(bridge: PermissionBridge, sessionKey: string, io?: StdioLike) {
    this.bridge = bridge
    this.sessionKey = sessionKey
    this.input = io?.input ?? process.stdin
    this.output = io?.output ?? process.stdout
  }

  start(): void {
    this.input.on('data', (chunk: Buffer | string) => this.onChunk(chunk))
  }

  /** Stops accepting new lines. Does not touch PermissionBridge's own parked
   *  requests -- callers that want those denied too should call
   *  `bridge.shutdown()` (kept separate since a server can be stopped without
   *  necessarily wanting to force-deny in-flight decisions, e.g. a graceful
   *  handoff). */
  stop(): void {
    this.stopped = true
  }

  private onChunk(chunk: Buffer | string): void {
    if (this.stopped) return
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    this.pendingBytes = Buffer.concat([this.pendingBytes, buf])

    let index: number
    while ((index = this.pendingBytes.indexOf(NEWLINE)) !== -1) {
      const lineBuf = this.pendingBytes.subarray(0, index)
      this.pendingBytes = this.pendingBytes.subarray(index + 1)
      const line = lineBuf.toString('utf8').trim()
      if (line.length > 0) void this.handleLine(line)
    }
    // A trailing partial line (no newline yet) is held, same as Transport's
    // stdout framing -- never parsed until its newline arrives.
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      // Malformed JSON line -- no id to reply to (we can't even tell if one
      // was intended), so log and drop rather than crash the server the CLI
      // is depending on for every subsequent tool call.
      console.warn('[permission-bridge] dropping malformed MCP line', err)
      return
    }

    const response = await routeMcpRequest(parsed, this.bridge, this.sessionKey)
    if (response === null || this.stopped) return

    try {
      this.output.write(JSON.stringify(response) + '\n')
    } catch (err) {
      // The CLI's end of the pipe is already gone (process exited mid-call) --
      // nothing useful to do with a write error at this point.
      console.warn('[permission-bridge] failed to write MCP response', err)
    }
  }
}
