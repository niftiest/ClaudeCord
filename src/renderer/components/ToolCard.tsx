import type { RenderItem } from '../../shared/types'

type ToolItem = Extract<RenderItem, { kind: 'tool' }>

export function ToolCard({ item, defaultOpen = false }: { item: ToolItem; defaultOpen?: boolean }) {
  const isError = item.result?.isError === true
  const summary = typeof item.input === 'object' && item.input !== null
    ? Object.entries(item.input as Record<string, unknown>)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
        .join(' ')
    : ''
  // Some tool calls (Write, Edit) can carry megabytes of file content in the
  // input payload; an unbounded JSON.stringify + <pre> would stall the
  // renderer on those. Cap it the same way the result text already is.
  const inputJson = JSON.stringify(item.input, null, 2) ?? ''
  return (
    <details className={isError ? 'tool err' : 'tool'} open={defaultOpen || undefined}>
      <summary>
        <span className="caret" aria-hidden="true">▸</span>
        <span className="nm">{item.name}</span>
        <span className="tool-args">{summary}</span>
        <span className="meta">{item.result === null ? 'no result' : isError ? 'error' : `${item.result.text.length} chars`}</span>
      </summary>
      <pre>{inputJson.slice(0, 8000)}</pre>
      {item.result !== null && <pre>{item.result.text.slice(0, 8000)}</pre>}
    </details>
  )
}
