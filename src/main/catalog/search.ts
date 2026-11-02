import type { Catalog } from './db'
import type { SearchHit } from '../../shared/types'

/**
 * FTS5 treats quotes and operators (AND/OR/NOT/NEAR, *, ^, -, :, parens) as
 * query syntax; users type prose. Quote each whitespace-separated term so it
 * is matched as a literal phrase rather than parsed as an operator.
 *
 * The schema's `unicode61` tokenizer treats *all* punctuation as a token
 * separator, not just quotes. That means any whitespace-separated token made
 * up entirely of punctuation (`-`, `*`, `^`, `(`, `---`, `!!!`, a stray `"`,
 * ...) tokenizes to zero terms. Quoted, it becomes an empty FTS5 phrase, and
 * an empty phrase ANDed with real terms matches nothing — silently zeroing
 * out the whole query even though the real terms are present. This is
 * ordinary human input: `config.py --verbose`, `wait...`, `fix this !!!`,
 * `the total (approx)`.
 *
 * So a term is kept only if it contains at least one character the
 * tokenizer will actually index — a Unicode letter or digit (`\p{L}`/`\p{N}`,
 * so CJK, accented, etc. all count, not just ASCII). Terms that are nothing
 * but punctuation are dropped entirely rather than turned into an empty
 * phrase. Terms that mix punctuation with letters/digits (`config.py`,
 * `--verbose`, `foo_bar`, `v2.1`) are kept and quote-stripped as before; the
 * tokenizer splits them into multiple tokens internally, so the quoted term
 * becomes a phrase query over adjacent tokens — that's correct and matches
 * the same text as indexed.
 */
function toMatchExpression(query: string): string {
  const terms = query
    .split(/\s+/)
    .filter(t => /[\p{L}\p{N}]/u.test(t))
    .map(t => t.replace(/"/g, ''))
  if (terms.length === 0) return ''
  return terms.map(t => `"${t}"`).join(' AND ')
}

export function search(db: Catalog, query: string, limit = 100): SearchHit[] {
  const match = toMatchExpression(query)
  if (match === '') return []
  return db.prepare(`
    SELECT m.session_pk AS sessionPk, s.session_id AS sessionId, p.dir_name AS projectDir,
           m.seq, m.ts,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_pk
    JOIN projects p ON p.id = s.project_id
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(match, limit) as SearchHit[]
}
