import { NAI_V5_CURATED, NAI_V5_FULL, NAI_V5_FULL_MEDIUM } from './nai-models'
import { normalizeSearchText, type SearchDocument } from './search-extract'
import type { ImageSearchFilter, SearchKindGroup } from './types'

/**
 * 검색 필터 해석 — 검색창의 인라인 문법(artist:, char:, seed:, model:, kind:, -제외, "구문")과
 * 필터 팝오버 값을 하나의 CompiledSearch로 합친다. 메인은 이걸 SQL로, 브라우저 작업 공간은
 * matchesSearchDocument로 같은 의미를 재현한다.
 */

export const SEARCH_KIND_GROUPS: readonly SearchKindGroup[] = [
  't2i',
  'i2i',
  'inpaint',
  'upscale',
  'scene',
  'director'
]

/** 'director' 묶음에 드는 히스토리 kind — 디렉터 툴(req_type)과 로컬 편집 */
export const DIRECTOR_KINDS: readonly string[] = [
  'director',
  'bg-removal',
  'lineart',
  'sketch',
  'colorize',
  'emotion',
  'declutter',
  'declutter-keep-bubbles',
  'mosaic',
  'pixelate'
]

export function isSearchKindGroup(value: string): value is SearchKindGroup {
  return (SEARCH_KIND_GROUPS as readonly string[]).includes(value)
}

/** 묶음 → 실제 kind 값들 */
export function expandKindGroups(groups: readonly SearchKindGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => (g === 'director' ? DIRECTOR_KINDS : [g])))]
}

/** 실제 kind → 묶음 (모르는 kind는 null) */
export function kindGroupOf(kind: string | null | undefined): SearchKindGroup | null {
  if (!kind) return null
  if (DIRECTOR_KINDS.includes(kind)) return 'director'
  return isSearchKindGroup(kind) ? kind : null
}

/** 필터에 보여 줄 표준 모델 — 색인에 다른 모델이 있으면 그 id가 그대로 덧붙는다 */
export const SEARCH_MODELS: readonly { id: string; label: string; aliases: readonly string[] }[] = [
  { id: NAI_V5_FULL, label: 'V5 Full (High)', aliases: ['v5-full', 'v5-high', 'v5'] },
  {
    id: NAI_V5_FULL_MEDIUM,
    label: 'V5 Full (Medium)',
    aliases: ['v5-medium', 'v5-full-medium']
  },
  { id: NAI_V5_CURATED, label: 'V5 Curated', aliases: ['v5-curated'] },
  { id: 'nai-diffusion-4-5-full', label: 'V4.5 Full', aliases: ['v4.5-full', 'v45-full', 'v4.5'] },
  {
    id: 'nai-diffusion-4-5-curated',
    label: 'V4.5 Curated',
    aliases: ['v4.5-curated', 'v45-curated']
  },
  { id: 'nai-diffusion-4-full', label: 'V4 Full', aliases: ['v4-full', 'v4'] },
  { id: 'nai-diffusion-4-curated-preview', label: 'V4 Curated', aliases: ['v4-curated'] },
  { id: 'nai-diffusion-3', label: 'V3', aliases: ['v3'] }
]

export function searchModelLabel(id: string): string {
  return SEARCH_MODELS.find((m) => m.id === id)?.label ?? id
}

/** `model:` 값 → 모델 id. 별칭·API id 모두 받는다 */
export function resolveSearchModel(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  const known = SEARCH_MODELS.find((m) => m.id === v || m.aliases.includes(v))
  if (known) return known.id
  return v.startsWith('nai-diffusion-') ? v : null
}

export type SearchTermField = 'any' | 'artist' | 'character'

/** 정규화된 텍스트 조건 하나 */
export interface SearchTerm {
  field: SearchTermField
  text: string
  negate: boolean
}

export interface CompiledSearch {
  terms: SearchTerm[]
  models: string[]
  excludedModels: string[]
  kinds: string[]
  excludedKinds: string[]
  seed: number | null
  /** 검색어 전체가 숫자 하나일 때 — 시드 일치 또는 그 숫자를 텍스트로 포함 */
  seedOrText: number | null
  dateFromUtc: string | null
  dateToUtc: string | null
  favoritesOnly: boolean
}

const MAX_SEED = 4294967295
const KEYS = new Set(['artist', 'char', 'character', 'seed', 'model', 'kind'])

interface RawToken {
  value: string
  negate: boolean
  /** 따옴표로 시작한 토큰은 key:value로 해석하지 않는다 */
  literal: boolean
}

/** 공백·쉼표로 나누되 따옴표 안은 한 토큰. `-`로 시작하면 제외 */
function tokenize(query: string): RawToken[] {
  const tokens: RawToken[] = []
  let current = ''
  let inQuote = false
  let started = false
  let negate = false
  let literal = false
  const flush = (): void => {
    if (started && current.trim()) tokens.push({ value: current.trim(), negate, literal })
    current = ''
    started = false
    negate = false
    literal = false
  }
  for (const ch of query) {
    if (ch === '"') {
      if (!started) {
        started = true
        literal = true
      }
      inQuote = !inQuote
      continue
    }
    if (!inQuote && (ch === ',' || /\s/.test(ch))) {
      flush()
      continue
    }
    if (!started) {
      started = true
      if (ch === '-') {
        negate = true
        continue
      }
    }
    current += ch
  }
  flush()
  return tokens
}

function parseSeed(value: string): number | null {
  if (!/^\d{1,10}$/.test(value.trim())) return null
  const n = Number(value)
  return n <= MAX_SEED ? n : null
}

function addTerm(terms: SearchTerm[], field: SearchTermField, raw: string, negate: boolean): void {
  const text = normalizeSearchText(raw)
  if (text && !terms.some((t) => t.field === field && t.text === text && t.negate === negate)) {
    terms.push({ field, text, negate })
  }
}

/** 필터를 해석한다. 조건이 하나도 없으면 null — 호출자는 기존 목록 쿼리를 쓴다 */
export function compileSearchFilter(
  filter: ImageSearchFilter | null | undefined
): CompiledSearch | null {
  if (!filter) return null
  const terms: SearchTerm[] = []
  const models = new Set<string>()
  const excludedModels = new Set<string>()
  const kindGroups = new Set<SearchKindGroup>()
  const excludedKindGroups = new Set<SearchKindGroup>()
  let seed: number | null = null
  let seedOrText: number | null = null

  const query = (filter.query ?? '').trim()
  const wholeNumber = /^\d{5,10}$/.test(query) ? parseSeed(query) : null
  if (wholeNumber !== null) {
    seedOrText = wholeNumber
  } else {
    for (const token of tokenize(query)) {
      const colon = token.value.indexOf(':')
      const key = colon > 0 ? token.value.slice(0, colon).toLowerCase() : ''
      if (token.literal || !KEYS.has(key)) {
        addTerm(terms, 'any', token.value, token.negate)
        continue
      }
      const value = token.value.slice(colon + 1)
      if (key === 'artist') addTerm(terms, 'artist', value, token.negate)
      else if (key === 'char' || key === 'character') {
        addTerm(terms, 'character', value, token.negate)
      } else if (key === 'seed') {
        const parsed = parseSeed(value)
        if (parsed !== null && !token.negate) seed = parsed
      } else if (key === 'model') {
        const id = resolveSearchModel(value)
        if (id) (token.negate ? excludedModels : models).add(id)
      } else if (key === 'kind') {
        const group = value.trim().toLowerCase()
        if (isSearchKindGroup(group)) (token.negate ? excludedKindGroups : kindGroups).add(group)
      }
    }
  }

  for (const artist of filter.artists ?? []) addTerm(terms, 'artist', artist, false)
  for (const character of filter.characters ?? []) addTerm(terms, 'character', character, false)
  for (const model of filter.models ?? []) if (model) models.add(model)
  for (const kind of filter.kinds ?? []) if (isSearchKindGroup(kind)) kindGroups.add(kind)
  if (typeof filter.seed === 'number' && Number.isInteger(filter.seed)) seed = filter.seed

  const compiled: CompiledSearch = {
    terms,
    models: [...models],
    excludedModels: [...excludedModels],
    kinds: expandKindGroups([...kindGroups]),
    excludedKinds: expandKindGroups([...excludedKindGroups]),
    seed,
    seedOrText,
    dateFromUtc: filter.dateFromUtc || null,
    dateToUtc: filter.dateToUtc || null,
    favoritesOnly: filter.favoritesOnly === true
  }
  const empty =
    compiled.terms.length === 0 &&
    compiled.models.length === 0 &&
    compiled.excludedModels.length === 0 &&
    compiled.kinds.length === 0 &&
    compiled.excludedKinds.length === 0 &&
    compiled.seed === null &&
    compiled.seedOrText === null &&
    !compiled.dateFromUtc &&
    !compiled.dateToUtc &&
    !compiled.favoritesOnly
  return empty ? null : compiled
}

export function hasActiveSearchFilter(filter: ImageSearchFilter | null | undefined): boolean {
  return compileSearchFilter(filter) !== null
}

/** 팝오버에서 고른 값의 수 (검색어 제외) — 필터 버튼 배지용 */
export function countFilterSelections(filter: ImageSearchFilter): number {
  return (
    (filter.artists?.length ?? 0) +
    (filter.characters?.length ?? 0) +
    (filter.models?.length ?? 0) +
    (filter.kinds?.length ?? 0) +
    (typeof filter.seed === 'number' ? 1 : 0) +
    (filter.dateFromUtc || filter.dateToUtc ? 1 : 0) +
    (filter.favoritesOnly ? 1 : 0)
  )
}

// ── FTS5 ──────────────────────────────────────────────

/** ASCII만으로 된 검색어 — FTS5(unicode61) 토큰으로 찾는다. 나머지(한글 등)는 부분 문자열 */
export function isAsciiTerm(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(text)
}

/** unicode61이 ASCII 텍스트를 나누는 방식 — 영숫자 묶음 */
export function asciiTokens(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * 검색어 → FTS5 구문 `"blue eye"*` (마지막 토큰은 접두 일치). 토큰이 영숫자뿐이라 따옴표·연산자·
 * 괄호 같은 FTS5 문법 문자가 들어갈 수 없다. column이 있으면 그 열로 한정. 토큰이 없으면 null.
 */
export function ftsPhrase(text: string, column?: string): string | null {
  const tokens = asciiTokens(text)
  if (tokens.length === 0) return null
  const phrase = `"${tokens.join(' ')}"*`
  return column ? `${column} : ${phrase}` : phrase
}

// ── 날짜 ──────────────────────────────────────────────

/** Date → SQLite datetime('now')와 같은 UTC 'YYYY-MM-DD HH:MM:SS' */
export function toSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** 저장된 시각(SQLite 형식 또는 ISO) → SQLite UTC 형식. 비교 전에 맞춘다 */
export function normalizeStoredTimestamp(value: string): string {
  if (!value.includes('T')) return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : toSqliteUtc(date)
}

function parseLocalDate(value: string, end: boolean): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const date = end
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59)
    : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 로컬 날짜 'YYYY-MM-DD' 범위 → 필터의 UTC 경계 (그날 0시 ~ 23:59:59 포함) */
export function localDateRangeToUtc(
  from: string | null | undefined,
  to: string | null | undefined
): { dateFromUtc: string | null; dateToUtc: string | null } {
  const start = from ? parseLocalDate(from, false) : null
  const end = to ? parseLocalDate(to, true) : null
  return {
    dateFromUtc: start ? toSqliteUtc(start) : null,
    dateToUtc: end ? toSqliteUtc(end) : null
  }
}

/** 필터의 UTC 경계 → 날짜 입력에 다시 보일 로컬 'YYYY-MM-DD' */
export function utcBoundToLocalDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 오늘을 끝으로 하는 최근 N일 (오늘 = 1일) 로컬 날짜 범위 */
export function recentLocalDays(days: number, now = new Date()): { from: string; to: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const fmt = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return { from: fmt(start), to: fmt(now) }
}

// ── 인메모리 매처 (브라우저 작업 공간) ───────────────────

/** 메인의 FTS5 접두 구문 일치와 같은 규칙 — 연속 토큰이 같고 마지막만 접두 일치 */
function phraseMatches(fieldTokens: string[], termTokens: string[]): boolean {
  const n = termTokens.length
  for (let i = 0; i + n <= fieldTokens.length; i++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      const token = fieldTokens[i + j]
      if (j === n - 1 ? !token.startsWith(termTokens[j]) : token !== termTokens[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** 정규화된 필드들 중 하나가 검색어에 맞는지 — ASCII는 토큰 구문 접두 일치, 그 밖은 부분 문자열 */
export function textMatches(fields: string[], text: string): boolean {
  if (isAsciiTerm(text)) {
    const termTokens = asciiTokens(text)
    if (termTokens.length === 0) return true
    return fields.some((field) => phraseMatches(asciiTokens(field), termTokens))
  }
  return fields.some((field) => field.includes(text))
}

export interface SearchMatchContext {
  /** 'YYYY-MM-DD HH:MM:SS' UTC */
  createdAt: string
  favorite?: boolean
  /** 라이브러리 이미지의 스택 이름 (정규화 전) */
  stackName?: string | null
}

/** 문서 하나가 필터에 맞는지 — 메인 SQL과 같은 의미 */
export function matchesSearchDocument(
  doc: SearchDocument,
  search: CompiledSearch,
  context: SearchMatchContext
): boolean {
  if (search.models.length > 0 && !(doc.modelId && search.models.includes(doc.modelId))) {
    return false
  }
  if (doc.modelId && search.excludedModels.includes(doc.modelId)) return false
  if (search.kinds.length > 0 && !(doc.kind && search.kinds.includes(doc.kind))) return false
  if (doc.kind && search.excludedKinds.includes(doc.kind)) return false
  if (search.seed !== null && doc.seed !== search.seed) return false
  const createdAt = normalizeStoredTimestamp(context.createdAt)
  if (search.dateFromUtc && createdAt < search.dateFromUtc) return false
  if (search.dateToUtc && createdAt > search.dateToUtc) return false
  if (search.favoritesOnly && !context.favorite) return false

  const stackText = normalizeSearchText(context.stackName ?? '')
  const anyFields = [doc.promptText, doc.artistText, doc.characterText, doc.nameText]
  if (search.seedOrText !== null) {
    const asText = String(search.seedOrText)
    if (doc.seed !== search.seedOrText && !textMatches([...anyFields, stackText], asText)) {
      return false
    }
  }
  for (const term of search.terms) {
    const fields =
      term.field === 'artist'
        ? [doc.artistText]
        : term.field === 'character'
          ? [doc.characterText]
          : [...anyFields, stackText]
    if (textMatches(fields, term.text) === term.negate) return false
  }
  return true
}
