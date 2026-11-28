import type Database from 'better-sqlite3'
import { normalizeSearchText } from '../../shared/search-extract'
import {
  ftsPhrase,
  isAsciiTerm,
  kindGroupOf,
  textMatches,
  type CompiledSearch,
  type SearchTerm
} from '../../shared/search-query'
import type { SearchFacetCount, SearchFacets } from '../../shared/types'

/**
 * 검색 필터 → SQL. 조건은 모두 *_search_meta(m)와 FTS5에만 건다 — payload_json을 LIKE로 훑지
 * 않는다. 텍스트 조건은 검색어마다 `m.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)`로 하나씩
 * 붙여 AND·NOT을 그대로 표현한다. ASCII가 아닌 검색어(한글 캐릭터 이름 등)는 unicode61 토큰과
 * 맞지 않으므로 정규화 텍스트에 instr로 찾는다.
 */

interface SearchScope {
  meta: 'image_search_meta' | 'library_search_meta'
  fts: 'image_search_fts' | 'library_search_fts'
  id: 'image_id' | 'library_image_id'
  /** 'any' 검색어가 보는 열 */
  anyColumns: readonly string[]
}

export const HISTORY_SCOPE: SearchScope = {
  meta: 'image_search_meta',
  fts: 'image_search_fts',
  id: 'image_id',
  anyColumns: ['prompt_text', 'artist_text', 'character_text']
}

export const LIBRARY_SCOPE: SearchScope = {
  meta: 'library_search_meta',
  fts: 'library_search_fts',
  id: 'library_image_id',
  anyColumns: ['name_text', 'prompt_text', 'artist_text', 'character_text']
}

export interface SqlWhere {
  sql: string
  params: unknown[]
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',')

function termColumns(scope: SearchScope, term: SearchTerm): readonly string[] {
  if (term.field === 'artist') return ['artist_text']
  if (term.field === 'character') return ['character_text']
  return scope.anyColumns
}

/** 스택 이름이 검색어에 맞는 스택 id들 (라이브러리 'any' 검색어용). 스택은 많지 않아 JS로 맞춘다 */
function matchingStackIds(db: Database.Database, text: string): number[] {
  const stacks = db.prepare('SELECT id, name FROM library_stacks').all() as {
    id: number
    name: string
  }[]
  return stacks.filter((s) => textMatches([normalizeSearchText(s.name)], text)).map((s) => s.id)
}

function textCondition(
  db: Database.Database,
  scope: SearchScope,
  term: SearchTerm,
  params: unknown[]
): string | null {
  const columns = termColumns(scope, term)
  const parts: string[] = []
  if (isAsciiTerm(term.text)) {
    // 열 하나면 FTS5 열 필터, 'any'(전 열)면 필터 없이
    const phrase = ftsPhrase(term.text, columns.length === 1 ? columns[0] : undefined)
    if (phrase) {
      parts.push(`m.${scope.id} IN (SELECT rowid FROM ${scope.fts} WHERE ${scope.fts} MATCH ?)`)
      params.push(phrase)
    }
  } else {
    for (const column of columns) {
      parts.push(`instr(m.${column}, ?) > 0`)
      params.push(term.text)
    }
  }
  if (scope === LIBRARY_SCOPE && term.field === 'any') {
    const stackIds = matchingStackIds(db, term.text)
    if (stackIds.length > 0) {
      parts.push(
        `m.${scope.id} IN (SELECT id FROM library_images WHERE stack_id IN (${placeholders(stackIds.length)}))`
      )
      params.push(...stackIds)
    }
  }
  if (parts.length === 0) return null
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`
}

/** 검색 조건 → `m`(meta) 별칭 기준 WHERE 절 (앞에 WHERE 없음, 조건이 없으면 '1') */
export function buildSearchWhere(
  db: Database.Database,
  scope: SearchScope,
  search: CompiledSearch
): SqlWhere {
  const conditions: string[] = []
  const params: unknown[] = []

  if (search.models.length > 0) {
    conditions.push(`m.model_id IN (${placeholders(search.models.length)})`)
    params.push(...search.models)
  }
  if (search.excludedModels.length > 0) {
    conditions.push(
      `(m.model_id IS NULL OR m.model_id NOT IN (${placeholders(search.excludedModels.length)}))`
    )
    params.push(...search.excludedModels)
  }
  if (search.kinds.length > 0) {
    conditions.push(`m.kind IN (${placeholders(search.kinds.length)})`)
    params.push(...search.kinds)
  }
  if (search.excludedKinds.length > 0) {
    conditions.push(
      `(m.kind IS NULL OR m.kind NOT IN (${placeholders(search.excludedKinds.length)}))`
    )
    params.push(...search.excludedKinds)
  }
  if (search.seed !== null) {
    conditions.push('m.seed = ?')
    params.push(search.seed)
  }
  if (search.dateFromUtc) {
    conditions.push('m.created_at >= ?')
    params.push(search.dateFromUtc)
  }
  if (search.dateToUtc) {
    conditions.push('m.created_at <= ?')
    params.push(search.dateToUtc)
  }
  if (search.favoritesOnly && scope === HISTORY_SCOPE) {
    conditions.push('m.image_id IN (SELECT id FROM images WHERE favorite = 1)')
  }
  if (search.seedOrText !== null) {
    const textParams: unknown[] = []
    const text = textCondition(
      db,
      scope,
      { field: 'any', text: String(search.seedOrText), negate: false },
      textParams
    )
    conditions.push(text ? `(m.seed = ? OR ${text})` : 'm.seed = ?')
    params.push(search.seedOrText, ...(text ? textParams : []))
  }
  for (const term of search.terms) {
    const termParams: unknown[] = []
    const condition = textCondition(db, scope, term, termParams)
    if (!condition) continue
    conditions.push(term.negate ? `NOT ${condition}` : condition)
    params.push(...termParams)
  }
  return { sql: conditions.length > 0 ? conditions.join(' AND ') : '1', params }
}

// ── 집계 (필터 팝오버) ─────────────────────────────────

const TOP_ARTISTS = 30

function facetsFor(db: Database.Database, scope: SearchScope): SearchFacets {
  const models = db
    .prepare(
      `SELECT model_id AS value, COUNT(*) AS count FROM ${scope.meta}
       WHERE model_id IS NOT NULL GROUP BY model_id ORDER BY count DESC`
    )
    .all() as SearchFacetCount[]

  const kindCounts = new Map<string, number>()
  const kindRows = db
    .prepare(
      `SELECT kind, COUNT(*) AS count FROM ${scope.meta} WHERE kind IS NOT NULL GROUP BY kind`
    )
    .all() as { kind: string; count: number }[]
  for (const row of kindRows) {
    const group = kindGroupOf(row.kind)
    if (group) kindCounts.set(group, (kindCounts.get(group) ?? 0) + row.count)
  }

  // 작가 수는 행마다 다르다 — artist_text를 나눠 센다 (meta 행은 작아 전체를 훑어도 가볍다)
  const artistCounts = new Map<string, number>()
  const artistRows = db
    .prepare(`SELECT artist_text FROM ${scope.meta} WHERE artist_text != ''`)
    .pluck()
    .iterate() as IterableIterator<string>
  for (const text of artistRows) {
    for (const name of new Set(text.split(' '))) {
      if (name) artistCounts.set(name, (artistCounts.get(name) ?? 0) + 1)
    }
  }
  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_ARTISTS)
    .map(([value, count]) => ({ value, count }))

  return {
    models,
    kinds: [...kindCounts.entries()].map(([value, count]) => ({ value, count })),
    topArtists
  }
}

export function searchFacets(db: Database.Database, scope: 'history' | 'library'): SearchFacets {
  return facetsFor(db, scope === 'history' ? HISTORY_SCOPE : LIBRARY_SCOPE)
}
