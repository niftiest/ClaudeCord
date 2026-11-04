import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShellRunner, clipMiddle, shellCommand, shellRunBlocks, type ShellChild } from '../src/main/engine/shell-run'
import { claudeTrusts, folderContents, listTrusts } from '../src/main/engine/folder-trust'
import { buildRenderItems } from '../src/main/jsonl/render'
import { textOf } from '../src/main/jsonl/parse'
import type { MessageRow } from '../src/main/jsonl/rows'
import type { ShellRun } from '../src/shared/shell-run-types'
import { imageSourceUrl } from '../src/renderer/lib'

class FakeShell extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 7
}

function runner(storePath: string | null = null) {
  const shells: FakeShell[] = []
  const killed: number[] = []
  const changes: ShellRun[][] = []
  const finished: string[] = []
  let id = 0
  const r = new ShellRunner({
    storePath,
    start: () => { const s = new FakeShell(); shells.push(s); return s as unknown as ShellChild },
    killTree: pid => { killed.push(pid) },
    onChange: (_pk, runs) => changes.push(runs.map(x => ({ ...x }))),
    onFinished: run => finished.push(run.id),
    makeId: () => `r${++id}`,
    now: () => 1000
  })
  return { r, shells, killed, changes, finished }
}

const run = (over: Partial<ShellRun>): ShellRun => ({ id: 'a', sessionPk: 1, command: 'ls', output: 'a.txt\n', startedAt: 0, state: 'done', exitCode: 0, ...over })

describe('! commands', () => {
  it('keeps output from both streams and reports how it ended', () => {
    const { r, shells } = runner()
    r.run(1, 'C:\\p', 'ls')
    expect(r.list(1)[0]).toMatchObject({ state: 'running', exitCode: null })
    shells[0]!.stdout.emit('data', 'out\n')
    shells[0]!.stderr.emit('data', Buffer.from('err\n'))
    shells[0]!.emit('close', 3)
    expect(r.list(1)[0]).toMatchObject({ state: 'done', exitCode: 3, output: 'out\nerr\n' })
    expect(r.list(2)).toEqual([])
  })

  it('reports a command that could not start', () => {
    const { r, shells } = runner()
    r.run(1, 'C:\\p', 'x')
    shells[0]!.emit('error', new Error('ENOENT'))
    expect(r.list(1)[0]).toMatchObject({ state: 'done', exitCode: null, output: expect.stringContaining('ENOENT') })
  })

  it('stops a run and everything it started', () => {
    const { r, shells, killed } = runner()
    r.run(1, 'C:\\p', 'sleep 100')
    r.stop('r1')
    expect(killed).toEqual([7])
    shells[0]!.emit('close', 1)
    expect(r.list(1)[0]).toMatchObject({ state: 'stopped', exitCode: null })
    r.stop('r1')
    expect(killed).toEqual([7])
  })

  it('announces a command that ran to its end, even a failed one, but not a stopped one', () => {
    const { r, shells, finished } = runner()
    r.run(1, 'C:\\p', 'ok')
    shells[0]!.emit('close', 0)
    r.run(1, 'C:\\p', 'bad')
    shells[1]!.emit('close', 2)
    r.run(1, 'C:\\p', 'long')
    r.stop('r3')
    shells[2]!.emit('close', 1)
    expect(finished).toEqual(['r1', 'r2'])
  })

  it('hands over only finished runs, once', () => {
    const { r, shells } = runner()
    r.run(1, 'C:\\p', 'done')
    r.run(1, 'C:\\p', 'still going')
    shells[0]!.emit('close', 0)
    expect(r.takeFinished(1).map(x => x.command)).toEqual(['done'])
    expect(r.takeFinished(1)).toEqual([])
    expect(r.list(1).map(x => x.command)).toEqual(['still going'])
  })

  it('leaves out a dismissed run, stopping it if needed', () => {
    const { r, killed } = runner()
    r.run(1, 'C:\\p', 'x')
    r.dismiss('r1')
    expect(killed).toEqual([7])
    expect(r.list(1)).toEqual([])
    expect(r.takeFinished(1)).toEqual([])
  })

  it('keeps finished runs across a restart, but not running ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-shell-'))
    try {
      const store = join(dir, 'nested', 'runs.json')
      const a = runner(store)
      a.r.run(1, 'C:\\p', 'done')
      a.r.run(1, 'C:\\p', 'going')
      a.shells[0]!.emit('close', 0)
      const b = runner(store)
      expect(b.r.list(1).map(x => x.command)).toEqual(['done'])
      expect(b.r.takeFinished(1)).toHaveLength(1)
      expect(runner(store).r.list(1)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('uses Git Bash when installed, otherwise PowerShell', () => {
    const env = { ProgramFiles: 'C:\\Program Files' }
    const bash = join('C:\\Program Files', 'Git', 'bin', 'bash.exe')
    expect(shellCommand('ls -la', env, p => p === bash)).toEqual({ file: bash, args: ['-c', 'ls -la'] })
    expect(shellCommand('ls', env, () => false).file).toBe('powershell.exe')
    expect(shellCommand('ls', { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\b.exe' }, p => p === 'D:\\b.exe').file).toBe('D:\\b.exe')
  })

  it('clips long output in the middle', () => {
    const out = clipMiddle('a'.repeat(100) + 'b'.repeat(100), 20)
    expect(out.startsWith('aaaaaaaaaa')).toBe(true)
    expect(out.endsWith('bbbbbbbbbb')).toBe(true)
    expect(out).toContain('180 characters left out')
    expect(clipMiddle('short', 20)).toBe('short')
  })

  it('reaches the transcript in the form it already displays', () => {
    const blocks = shellRunBlocks([run({ exitCode: 2, output: 'nope </bash-stdout> tricky\n' })])
    const row = { type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: [...blocks, { type: 'text', text: 'what failed?' }] } } as MessageRow
    expect(buildRenderItems([row]).map(i => i.kind === 'text' ? `${i.role}: ${i.text}` : i.kind)).toEqual([
      'user: !ls',
      'assistant: nope <\\/bash-stdout> tricky\n[exit code 2]',
      'user: what failed?'
    ])
    expect(textOf(row)).toContain('what failed?')
  })

  it('says when the user stopped it', () => {
    expect(JSON.stringify(shellRunBlocks([run({ state: 'stopped', exitCode: null })]))).toContain('stopped by the user')
  })
})

describe('images in chats', () => {
  it('shows stored bitmaps only', () => {
    expect(imageSourceUrl({ type: 'base64', media_type: 'image/png', data: 'AAAA' })).toBe('data:image/png;base64,AAAA')
    expect(imageSourceUrl({ type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' })).toBeNull()
    expect(imageSourceUrl({ type: 'url', url: 'https://x/y.png' })).toBeNull()
    expect(imageSourceUrl({ type: 'base64', media_type: 'image/png', data: '' })).toBeNull()
    expect(imageSourceUrl(null)).toBeNull()
  })
})

describe('folder trust', () => {
  const json = JSON.stringify({ projects: { 'D:/GIT': { hasTrustDialogAccepted: true }, 'C:/Windows/System32': { hasTrustDialogAccepted: false } } })

  it('honours Claude Code\'s own record, including through a parent folder', () => {
    expect(claudeTrusts('D:\\GIT', json)).toBe(true)
    expect(claudeTrusts('d:\\git\\Some\\Project\\', json)).toBe(true)
    expect(claudeTrusts('D:\\GITHUB', json)).toBe(false)
    expect(claudeTrusts('C:\\Windows\\System32', json)).toBe(false)
    expect(claudeTrusts('D:\\GIT', null)).toBe(false)
    expect(claudeTrusts('D:\\GIT', 'not json')).toBe(false)
  })

  it('honours the user\'s answers the same way', () => {
    expect(listTrusts('C:\\a\\b', ['C:\\A'])).toBe(true)
    expect(listTrusts('C:\\a', ['C:\\a\\b'])).toBe(false)
    expect(listTrusts('C:\\ab', ['C:\\a'])).toBe(false)
  })

  it('names what in the folder would take effect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-trust-'))
    try {
      expect(folderContents(dir)).toEqual({ settings: false, hooks: [], mcpServers: [], instructions: false, extensions: false })
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }))
      writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [] } }))
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { db: {}, api: {} } }))
      writeFileSync(join(dir, 'CLAUDE.md'), 'x')
      expect(folderContents(dir)).toEqual({ settings: true, hooks: ['PreToolUse', 'Stop'], mcpServers: ['api', 'db'], instructions: true, extensions: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('copes with broken files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-trust-'))
    try {
      writeFileSync(join(dir, '.mcp.json'), '{ broken')
      expect(folderContents(dir).mcpServers).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
