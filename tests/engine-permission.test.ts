import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  buildPermissionResult,
  toMcpToolResult,
  parsePermissionArgs,
  allowAlwaysRule,
  PermissionBridge,
  routeMcpRequest,
  McpStdioServer
} from '../src/main/engine/permission-bridge'
import type { PermissionDecision } from '../src/shared/engine-types'

// ---------------------------------------------------------------------------
// buildPermissionResult -- the DOCUMENTED response contract, pinned exactly
// ---------------------------------------------------------------------------

describe('buildPermissionResult', () => {
  it('allow with no updatedInput falls back to the original input', () => {
    const decision: PermissionDecision = { behavior: 'allow' }
    const result = buildPermissionResult(decision, { command: 'ls' })
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  it('allow with updatedInput uses the edited input verbatim', () => {
    const decision: PermissionDecision = { behavior: 'allow', updatedInput: { command: 'ls -la' } }
    const result = buildPermissionResult(decision, { command: 'ls' })
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } })
  })

  it('deny carries behavior+message and no updatedInput field', () => {
    const decision: PermissionDecision = { behavior: 'deny', message: 'not allowed' }
    const result = buildPermissionResult(decision, { command: 'rm -rf /' })
    expect(result).toEqual({ behavior: 'deny', message: 'not allowed' })
    expect('updatedInput' in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// toMcpToolResult -- MCP text-content-block wrapper
// ---------------------------------------------------------------------------

describe('toMcpToolResult', () => {
  it('wraps into { content: [{ type: text, text: <json> }] } and round-trips', () => {
    const result = { behavior: 'allow', updatedInput: { command: 'ls' } }
    const wrapped = toMcpToolResult(result)
    expect(wrapped.content).toHaveLength(1)
    expect(wrapped.content[0]?.type).toBe('text')
    expect(JSON.parse(wrapped.content[0]?.text ?? '')).toEqual(result)
  })
})

// ---------------------------------------------------------------------------
// parsePermissionArgs -- tolerant parse of the UNDOCUMENTED request shape
// ---------------------------------------------------------------------------

describe('parsePermissionArgs', () => {
  it('full shape -> full request', () => {
    const req = parsePermissionArgs(
      { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_01' },
      'id-1',
      'session-a'
    )
    expect(req).toEqual({ id: 'id-1', tool: 'Bash', input: { command: 'ls' }, sessionKey: 'session-a', toolUseId: 'toolu_01' })
  })

  it('missing tool_use_id -> field omitted, not undefined-valued', () => {
    const req = parsePermissionArgs({ tool_name: 'Read', input: { file_path: 'a.txt' } }, 'id-2', 'session-a')
    expect('toolUseId' in req).toBe(false)
    expect(req.tool).toBe('Read')
  })

  it('missing tool_name -> defensible fallback, does not throw', () => {
    expect(() => parsePermissionArgs({ input: { command: 'x' } }, 'id-3', 'session-a')).not.toThrow()
    const req = parsePermissionArgs({ input: { command: 'x' } }, 'id-3', 'session-a')
    expect(req.tool).toBe('unknown')
  })

  it('junk / non-object args -> defensible non-throwing result', () => {
    expect(() => parsePermissionArgs(null, 'id-4', 'session-a')).not.toThrow()
    expect(() => parsePermissionArgs('garbage', 'id-5', 'session-a')).not.toThrow()
    expect(() => parsePermissionArgs(42, 'id-6', 'session-a')).not.toThrow()
    expect(() => parsePermissionArgs(undefined, 'id-7', 'session-a')).not.toThrow()

    const req = parsePermissionArgs(null, 'id-4', 'session-a')
    expect(req.id).toBe('id-4')
    expect(req.tool).toBe('unknown')
    expect(req.sessionKey).toBe('session-a')
  })

  it('logs unknown fields but does not fail on them', () => {
    const req = parsePermissionArgs(
      { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_01', some_future_field: 'xyz' },
      'id-8',
      'session-a'
    )
    expect(req.tool).toBe('Bash')
  })
})

// ---------------------------------------------------------------------------
// allowAlwaysRule
// ---------------------------------------------------------------------------

describe('allowAlwaysRule', () => {
  it('Bash command -> Tool(command-prefix *) style rule', () => {
    expect(allowAlwaysRule('Bash', { command: 'npx playwright test' })).toBe('Bash(npx playwright *)')
    expect(allowAlwaysRule('Bash', { command: 'npm run build' })).toBe('Bash(npm run *)')
  })

  it('Bash single-token command still wildcards', () => {
    expect(allowAlwaysRule('Bash', { command: 'ls' })).toBe('Bash(ls *)')
  })

  it('Bash with no command input falls back to bare tool name', () => {
    expect(allowAlwaysRule('Bash', {})).toBe('Bash')
    expect(allowAlwaysRule('Bash', null)).toBe('Bash')
  })

  it('Read/Edit with a path -> path-scoped rule', () => {
    expect(allowAlwaysRule('Read', { file_path: './.env' })).toBe('Read(./.env)')
    expect(allowAlwaysRule('Edit', { file_path: 'src/index.ts' })).toBe('Edit(src/index.ts)')
  })

  it('Read/Edit with no path -> bare tool name', () => {
    expect(allowAlwaysRule('Read', {})).toBe('Read')
  })

  it('unknown tool -> bare tool name', () => {
    expect(allowAlwaysRule('WebFetch', { url: 'https://example.com' })).toBe('WebFetch')
  })
})

// ---------------------------------------------------------------------------
// PermissionBridge -- parking coordinator
// ---------------------------------------------------------------------------

describe('PermissionBridge', () => {
  it('handleToolCall parks and does not resolve until resolve() is called', async () => {
    const bridge = new PermissionBridge()
    let settled = false
    const promise = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'ls' } }, 'session-a')
    void promise.then(() => {
      settled = true
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
  })

  it('onRequest fires with the parsed request and a stable id; resolve() completes with the right MCP result', async () => {
    const bridge = new PermissionBridge()
    let seenId = ''
    bridge.onRequest((req) => {
      expect(req.tool).toBe('Bash')
      expect(req.sessionKey).toBe('session-a')
      seenId = req.id
    })

    const promise = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'ls' } }, 'session-a')
    expect(seenId).not.toBe('')

    bridge.resolve(seenId, { behavior: 'allow' })
    const result = (await promise) as { content: { type: string; text: string }[] }
    expect(result.content[0]?.type).toBe('text')
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  it('deny decision resolves to a deny MCP result', async () => {
    const bridge = new PermissionBridge()
    let seenId = ''
    bridge.onRequest((req) => {
      seenId = req.id
    })
    const promise = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'rm -rf /' } }, 'session-a')
    bridge.resolve(seenId, { behavior: 'deny', message: 'nope' })
    const result = (await promise) as { content: { type: string; text: string }[] }
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ behavior: 'deny', message: 'nope' })
  })

  it('two concurrent requests get distinct ids and resolve independently', async () => {
    const bridge = new PermissionBridge()
    const ids: string[] = []
    bridge.onRequest((req) => ids.push(req.id))

    const p1 = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    const p2 = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'b' } }, 'session-a')

    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])

    bridge.resolve(ids[1] as string, { behavior: 'allow' })
    const r2 = (await p2) as { content: { type: string; text: string }[] }
    expect(JSON.parse(r2.content[0]?.text ?? '')).toEqual({ behavior: 'allow', updatedInput: { command: 'b' } })

    // p1 still parked -- only resolving p2 must not have resolved it.
    let p1Settled = false
    void p1.then(() => {
      p1Settled = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(p1Settled).toBe(false)

    bridge.resolve(ids[0] as string, { behavior: 'deny', message: 'no' })
    const r1 = (await p1) as { content: { type: string; text: string }[] }
    expect(JSON.parse(r1.content[0]?.text ?? '')).toEqual({ behavior: 'deny', message: 'no' })
  })

  it('resolving an unknown id is a safe no-op', () => {
    const bridge = new PermissionBridge()
    expect(() => bridge.resolve('never-existed', { behavior: 'allow' })).not.toThrow()
  })

  it('resolving the same id twice is a safe no-op the second time', async () => {
    const bridge = new PermissionBridge()
    let seenId = ''
    bridge.onRequest((req) => {
      seenId = req.id
    })
    const promise = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    bridge.resolve(seenId, { behavior: 'allow' })
    expect(() => bridge.resolve(seenId, { behavior: 'deny', message: 'too late' })).not.toThrow()
    const result = (await promise) as { content: { type: string; text: string }[] }
    // First resolve wins -- the second (unknown-id-by-then) call is a no-op.
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ behavior: 'allow', updatedInput: { command: 'a' } })
  })

  it('a request unresolved by the configured timeout resolves to deny, not hang', async () => {
    const bridge = new PermissionBridge({ timeoutMs: 20 })
    const promise = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    const result = (await promise) as { content: { type: string; text: string }[] }
    const parsed = JSON.parse(result.content[0]?.text ?? '')
    expect(parsed.behavior).toBe('deny')
    expect(typeof parsed.message).toBe('string')
  })

  it('shutdown() denies every still-parked request', async () => {
    const bridge = new PermissionBridge()
    const p1 = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    const p2 = bridge.handleToolCall({ tool_name: 'Bash', input: { command: 'b' } }, 'session-a')

    bridge.shutdown()

    const [r1, r2] = (await Promise.all([p1, p2])) as { content: { type: string; text: string }[] }[]
    expect(JSON.parse(r1?.content[0]?.text ?? '').behavior).toBe('deny')
    expect(JSON.parse(r2?.content[0]?.text ?? '').behavior).toBe('deny')
  })

  it('handleToolCall after shutdown() denies immediately rather than parking', async () => {
    const bridge = new PermissionBridge()
    bridge.shutdown()
    const result = (await bridge.handleToolCall(
      { tool_name: 'Bash', input: { command: 'a' } },
      'session-a'
    )) as { content: { type: string; text: string }[] }
    expect(JSON.parse(result.content[0]?.text ?? '').behavior).toBe('deny')
  })

  it('toolName defaults to approve and is overridable', () => {
    expect(new PermissionBridge().toolName).toBe('approve')
    expect(new PermissionBridge({ toolName: 'custom' }).toolName).toBe('custom')
  })
})

// ---------------------------------------------------------------------------
// JSON-RPC framing / routing
// ---------------------------------------------------------------------------

describe('routeMcpRequest', () => {
  it('initialize responds promptly with protocolVersion + capabilities + serverInfo', async () => {
    const bridge = new PermissionBridge()
    const res = await routeMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      bridge,
      'session-a'
    )
    expect(res?.id).toBe(1)
    const result = res?.result as { protocolVersion: string; serverInfo: { name: string } }
    expect(result.protocolVersion).toBe('2024-11-05')
    expect(result.serverInfo.name).toBeTruthy()
  })

  it('notifications/initialized (no id) produces no response', async () => {
    const bridge = new PermissionBridge()
    const res = await routeMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, bridge, 'session-a')
    expect(res).toBeNull()
  })

  it('tools/list advertises exactly one tool named after bridge.toolName', async () => {
    const bridge = new PermissionBridge({ toolName: 'approve' })
    const res = await routeMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, bridge, 'session-a')
    const result = res?.result as { tools: { name: string }[] }
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]?.name).toBe('approve')
  })

  it('a recorded tools/call request routes to handleToolCall and produces the MCP result envelope', async () => {
    const bridge = new PermissionBridge()
    bridge.onRequest((req) => {
      bridge.resolve(req.id, { behavior: 'allow' })
    })

    // Constructed per the MCP spec's tools/call shape, carrying the
    // undocumented-but-de-facto tool_name/input/tool_use_id arguments.
    const recordedRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'tools/call',
      params: {
        name: 'approve',
        arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_01' }
      }
    }

    const res = await routeMcpRequest(recordedRequest, bridge, 'session-a')
    expect(res?.id).toBe('req-1')
    const result = res?.result as { content: { type: string; text: string }[] }
    expect(result.content[0]?.type).toBe('text')
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  it('unknown method with an id gets a JSON-RPC error response', async () => {
    const bridge = new PermissionBridge()
    const res = await routeMcpRequest({ jsonrpc: '2.0', id: 9, method: 'nonsense/method' }, bridge, 'session-a')
    expect(res?.error?.code).toBe(-32601)
  })

  it('malformed / non-object request with no id produces no response', async () => {
    const bridge = new PermissionBridge()
    expect(await routeMcpRequest(null, bridge, 'session-a')).toBeNull()
    expect(await routeMcpRequest('garbage', bridge, 'session-a')).toBeNull()
    expect(await routeMcpRequest({ notJsonRpc: true }, bridge, 'session-a')).toBeNull()
  })

  it('malformed request that does carry an id gets an invalid-request error, not a throw', async () => {
    const bridge = new PermissionBridge()
    const res = await routeMcpRequest({ id: 5, notAMethodField: true }, bridge, 'session-a')
    expect(res?.id).toBe(5)
    expect(res?.error?.code).toBe(-32600)
  })
})

// ---------------------------------------------------------------------------
// McpStdioServer -- newline-delimited JSON-RPC over injectable streams
// ---------------------------------------------------------------------------

describe('McpStdioServer', () => {
  it('handles a request split across chunks and writes one framed response line', async () => {
    const bridge = new PermissionBridge()
    const input = new PassThrough()
    const output = new PassThrough()
    const server = new McpStdioServer(bridge, 'session-a', { input, output })
    server.start()

    const written: string[] = []
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))

    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
    // Split the line across two writes to prove byte-safe line framing.
    input.write(line.slice(0, 5))
    input.write(line.slice(5))

    await vi.waitFor(() => {
      expect(written.join('')).toContain('"id":1')
    })

    const response = JSON.parse(written.join('').trim())
    expect(response.result.tools).toHaveLength(1)
  })

  it('a malformed JSON line is dropped without crashing the server', async () => {
    const bridge = new PermissionBridge()
    const input = new PassThrough()
    const output = new PassThrough()
    const server = new McpStdioServer(bridge, 'session-a', { input, output })
    server.start()

    const written: string[] = []
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))

    input.write('not json at all\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n')

    await vi.waitFor(() => {
      expect(written.join('')).toContain('"id":7')
    })
  })

  it('two requests arriving in one chunk both get responses', async () => {
    const bridge = new PermissionBridge()
    const input = new PassThrough()
    const output = new PassThrough()
    const server = new McpStdioServer(bridge, 'session-a', { input, output })
    server.start()

    const written: string[] = []
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))

    const l1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const l2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    input.write(l1 + '\n' + l2 + '\n')

    await vi.waitFor(() => {
      const joined = written.join('')
      expect(joined).toContain('"id":1')
      expect(joined).toContain('"id":2')
    })
  })
})
