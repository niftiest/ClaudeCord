import { describe, it, expect } from 'vitest'
import { openCatalog, closeCatalog } from '../src/main/catalog/db'
import { upsertProject, setProjectCwd } from '../src/main/catalog/repos'
import { setFriendlyName, setStarred, setChannelIcon, setChannelGroup, createGroup } from '../src/main/catalog/metadata'
import { listChannels } from '../src/main/ipc'

describe('listChannels', () => {
  it('merges each project with its default metadata when none has been set', () => {
    const db = openCatalog(':memory:')
    upsertProject(db, 'proj-a')
    const channels = listChannels(db)
    expect(channels).toHaveLength(1)
    expect(channels[0]!.dirName).toBe('proj-a')
    expect(channels[0]!.meta).toEqual({
      dirName: 'proj-a', friendlyName: null, starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false
    })
    closeCatalog(db)
  })

  it('merges custom metadata (name/star/icon/group) onto the matching project', () => {
    const db = openCatalog(':memory:')
    const id = upsertProject(db, 'proj-b')
    setProjectCwd(db, id, '/home/me/proj-b')
    const groupId = createGroup(db, 'Work')
    setFriendlyName(db, 'proj-b', 'My Project')
    setStarred(db, 'proj-b', true)
    setChannelIcon(db, 'proj-b', { kind: 'emoji', emoji: '🚀' })
    setChannelGroup(db, 'proj-b', groupId)

    const channels = listChannels(db)
    expect(channels).toHaveLength(1)
    const c = channels[0]!
    expect(c.cwd).toBe('/home/me/proj-b')
    expect(c.meta.friendlyName).toBe('My Project')
    expect(c.meta.starred).toBe(true)
    expect(c.meta.icon).toEqual({ kind: 'emoji', emoji: '🚀' })
    expect(c.meta.groupId).toBe(groupId)
    closeCatalog(db)
  })

  it('keeps each channel keyed to its own metadata (no cross-contamination between channels)', () => {
    const db = openCatalog(':memory:')
    upsertProject(db, 'proj-a')
    upsertProject(db, 'proj-b')
    setFriendlyName(db, 'proj-a', 'Alpha')
    setStarred(db, 'proj-b', true)

    const byName = new Map(listChannels(db).map(c => [c.dirName, c]))
    expect(byName.get('proj-a')!.meta.friendlyName).toBe('Alpha')
    expect(byName.get('proj-a')!.meta.starred).toBe(false)
    expect(byName.get('proj-b')!.meta.friendlyName).toBeNull()
    expect(byName.get('proj-b')!.meta.starred).toBe(true)
    closeCatalog(db)
  })

  it('returns an empty array when there are no projects', () => {
    const db = openCatalog(':memory:')
    expect(listChannels(db)).toEqual([])
    closeCatalog(db)
  })
})
