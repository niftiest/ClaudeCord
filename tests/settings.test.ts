import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog, closeCatalog } from '../src/main/catalog/db'
import { SCHEMA_VERSION } from '../src/main/catalog/schema'
import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../src/main/catalog/settings'

describe('settings store', () => {
  it('returns full defaults on a fresh DB', () => {
    const db = openCatalog(':memory:')
    expect(getSettings(db)).toEqual(DEFAULT_SETTINGS)
  })

  it('a partial update preserves the other fields', () => {
    const db = openCatalog(':memory:')
    const next = updateSettings(db, { theme: 'terminal', idleReapMin: 8 })
    expect(next.theme).toBe('terminal')
    expect(next.idleReapMin).toBe(8)
    expect(next.startWithAdmin).toBe(DEFAULT_SETTINGS.startWithAdmin) // untouched
    // persisted: reading fresh returns the same
    expect(getSettings(db).theme).toBe('terminal')
  })

  it('round-trips every field type (bool/string/null/number/enum/array)', () => {
    const db = openCatalog(':memory:')
    const patch = {
      startWithAdmin: true, defaultModel: 'opus', defaultCwd: 'C:\\x', defaultBudgetUsd: 15,
      theme: 'terminal' as const, density: 'compact' as const, idleReapMin: 45,
      extraFlags: ['--verbose', '--foo'], autoCleanDays: null
    }
    const next = updateSettings(db, patch)
    expect(next.startWithAdmin).toBe(true)
    expect(next.defaultModel).toBe('opus')
    expect(next.defaultBudgetUsd).toBe(15)
    expect(next.theme).toBe('terminal')
    expect(next.extraFlags).toEqual(['--verbose', '--foo'])
    expect(next.autoCleanDays).toBeNull()
  })

  it('rejects invalid values, keeping the default', () => {
    const db = openCatalog(':memory:')
    // @ts-expect-error deliberately wrong types at the boundary
    const next = updateSettings(db, { theme: 'neon', idleReapMin: -5, extraFlags: [1, 2] })
    expect(next.theme).toBe('discord')        // 'neon' rejected
    expect(next.idleReapMin).toBe(10)          // negative rejected
    expect(next.extraFlags).toEqual([])        // non-string array rejected
  })

  it('themeScope defaults to chat, accepts app, rejects anything else', () => {
    expect(DEFAULT_SETTINGS.themeScope).toBe('chat')
    const db = openCatalog(':memory:')
    expect(updateSettings(db, { themeScope: 'app' }).themeScope).toBe('app')
    expect(updateSettings(db, { themeScope: 'sidebar' as never }).themeScope).toBe('app') // invalid keeps prior
  })

  it('defaults theme to discord and drops legacy dark/light/system values', () => {
    const db = openCatalog(':memory:')
    expect(DEFAULT_SETTINGS.theme).toBe('discord')
    // Builds before the theme picker stored an (unused) dark/light/system value.
    for (const legacy of ['dark', 'light', 'system']) {
      db.prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('theme', JSON.stringify(legacy))
      expect(getSettings(db).theme).toBe('discord')
    }
    expect(updateSettings(db, { theme: 'terminal' }).theme).toBe('terminal')
    expect(updateSettings(db, { theme: 'discord' }).theme).toBe('discord')
  })

  it('floors a non-integer idle limit', () => {
    const db = openCatalog(':memory:')
    expect(updateSettings(db, { idleReapMin: 12.7 }).idleReapMin).toBe(12)   // floored
  })

  it('a malformed stored value falls back to the default on read', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('theme', 'not json')").run()
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('idleReapMin', '\"nope\"')").run()
    const s = getSettings(db)
    expect(s.theme).toBe('discord')
    expect(s.idleReapMin).toBe(10)
  })

  it('ignores the old limit on concurrent chats if an earlier version saved one', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('maxConcurrent', '4')").run()
    expect(getSettings(db)).not.toHaveProperty('maxConcurrent')
  })

  it('migration v3 creates settings_kv without disturbing existing data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-set-'))
    const path = join(dir, 'catalog.db')
    try {
      // Build a v2-shaped DB: seed a project, drop settings_kv, roll version to 2.
      const db = openCatalog(path)
      db.prepare("INSERT INTO projects (dir_name, cwd) VALUES ('C--Demo', 'C:\\\\Demo')").run()
      db.exec('DROP TABLE settings_kv')
      db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run()
      closeCatalog(db)
      // Reopen — the runner adds settings_kv (v3) and brings the DB to current,
      // data intact.
      const db2 = openCatalog(path)
      expect((db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe(String(SCHEMA_VERSION))
      expect(getSettings(db2)).toEqual(DEFAULT_SETTINGS) // usable immediately
      expect((db2.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c).toBe(1)
      closeCatalog(db2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('retention settings', () => {
  it('auto-clean days: whole days >= 1 or null; per-project map validated as a whole', () => {
    const db = openCatalog(':memory:')
    expect(DEFAULT_SETTINGS.autoCleanDays).toBeNull()
    expect(updateSettings(db, { autoCleanDays: 90 }).autoCleanDays).toBe(90)
    expect(updateSettings(db, { autoCleanDays: 0 }).autoCleanDays).toBe(90)
    expect(updateSettings(db, { autoCleanDays: 1.5 }).autoCleanDays).toBe(90)
    expect(updateSettings(db, { autoCleanDays: null }).autoCleanDays).toBeNull()
    expect(updateSettings(db, { autoCleanProjects: { 'D--GIT-App': null, 'C--x': 30 } }).autoCleanProjects).toEqual({ 'D--GIT-App': null, 'C--x': 30 })
    expect(updateSettings(db, { autoCleanProjects: { 'a/b': 30 } }).autoCleanProjects).toEqual({ 'D--GIT-App': null, 'C--x': 30 })
    expect(updateSettings(db, { autoCleanProjects: { a: -1 } }).autoCleanProjects).toEqual({ 'D--GIT-App': null, 'C--x': 30 })
  })
})
