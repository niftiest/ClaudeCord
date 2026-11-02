import { RemoteBadge } from './RemoteBadge'
import { useState } from 'react'
import type { ChannelRow } from '../../shared/types'
import { plainPreview, resolveChannelName, resolveChannelIcon, relativeTime, type NavSection, type ResolvedIcon } from '../lib'

/** Renders a single channel's circular avatar per its ResolvedIcon: the
 *  initials-default (deterministic text + background color, same look the
 *  pre-metadata nav always had), an emoji on a neutral background, a flat
 *  color swatch, or an uploaded image (cropped to fill the circle). */
function ChannelAvatar({ icon }: { icon: ResolvedIcon }) {
  switch (icon.kind) {
    case 'initials':
      return <span className="ch-avatar" style={{ background: icon.color }} aria-hidden="true">{icon.text}</span>
    case 'emoji':
      return <span className="ch-avatar ch-avatar-emoji" aria-hidden="true">{icon.emoji}</span>
    case 'color':
      return <span className="ch-avatar" style={{ background: icon.color }} aria-hidden="true" />
    case 'image':
      return <span className="ch-avatar" aria-hidden="true"><img src={icon.dataUrl} alt="" /></span>
  }
}

function ChannelItem({ channel, selected, unread, remote, onSelect, onContextMenu }: {
  channel: ChannelRow
  selected: boolean
  unread: boolean
  remote: boolean
  onSelect: (channel: ChannelRow) => void
  onContextMenu: (channel: ChannelRow, x: number, y: number) => void
}) {
  const name = resolveChannelName(channel.meta, channel.cwd, channel.dirName)
  const icon = resolveChannelIcon(channel.meta, name)
  return (
    <div className={`ch${unread ? ' unread' : ''}`} role="option" tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(channel)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(channel) } }}
      onContextMenu={e => { e.preventDefault(); onContextMenu(channel, e.clientX, e.clientY) }}>
      <span className="ch-avatar-wrap">
        <ChannelAvatar icon={icon} />
        {remote && <RemoteBadge className="rc-badge-nav" />}
      </span>
      <div className="ch-body">
        <div className="ch-top">
          <span className="ch-name">{name}</span>
          {channel.meta.starred && <span className="ch-star" aria-label="Starred" title="Starred">★</span>}
          <time className="ch-time">{relativeTime(channel.lastActivity)}</time>
        </div>
        <div className="ch-preview">
          {(channel.preview !== null && channel.preview !== undefined ? plainPreview(channel.preview) : null) ?? `${channel.sessionCount} session${channel.sessionCount === 1 ? '' : 's'}`}
        </div>
      </div>
      {unread && <span className="ch-unread-badge" aria-label="Unread messages" title="Unread messages" />}
    </div>
  )
}

/** One collapsible section (Starred / a named group / Ungrouped). Section
 *  collapse state is purely local UI state (not persisted) -- reopening the
 *  app always shows every section expanded. */
function Section({ section, selectedId, unread, remote, onSelect, onContextMenu, defaultCollapsed = false }: {
  section: NavSection
  selectedId: number | null
  unread: Set<number>
  remote: Set<number>
  onSelect: (channel: ChannelRow) => void
  onContextMenu: (channel: ChannelRow, x: number, y: number) => void
  defaultCollapsed?: boolean
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <div className="nav-section">
      <button type="button" className="nav-section-head" aria-expanded={!collapsed}
        onClick={() => setCollapsed(c => !c)}>
        <span className={`nav-section-caret${collapsed ? ' collapsed' : ''}`} aria-hidden="true">▾</span>
        {section.kind === 'starred' && <span className="nav-section-star" aria-hidden="true">★</span>}
        <span>{section.title}</span>
        <span className="nav-sub" style={{ marginLeft: 'auto' }}>{section.channels.length}</span>
      </button>
      {!collapsed && (
        section.channels.length === 0
          ? <div className="nav-section-empty">No chats here yet.</div>
          : section.channels.map(c => (
            <ChannelItem key={c.id} channel={c} selected={c.id === selectedId} unread={unread.has(c.id)} remote={remote.has(c.id)}
              onSelect={onSelect} onContextMenu={onContextMenu} />
          ))
      )}
    </div>
  )
}

/** Renders the nav's sectioned model (Plan 3 Task 2): a Starred section
 *  pinning favorites at the top, each user group (in sortOrder) below it,
 *  and an Ungrouped section last -- exactly what `groupChannels`
 *  (src/renderer/lib.ts) computes. Right-clicking a row surfaces
 *  `onContextMenu`, which Nav.tsx wires to ChannelContextMenu. */
export function GroupedNav({ sections, selectedId, unread, remote = new Set<number>(), onSelect, onContextMenu }: {
  sections: NavSection[]
  selectedId: number | null
  unread: Set<number>
  remote?: Set<number>
  onSelect: (channel: ChannelRow) => void
  onContextMenu: (channel: ChannelRow, x: number, y: number) => void
}) {
  return (
    <>
      {sections.map(s => (
        <Section key={s.kind === 'group' ? `group:${s.groupId}` : s.kind === 'time' ? `time:${s.bucket}` : s.kind}
          section={s} selectedId={selectedId} unread={unread} remote={remote} onSelect={onSelect} onContextMenu={onContextMenu}
          defaultCollapsed={s.kind === 'hidden'} />
      ))}
    </>
  )
}
