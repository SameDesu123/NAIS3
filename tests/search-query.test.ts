import { describe, expect, it } from 'vitest'
import { searchDocumentFromPayload, type SearchDocument } from '../src/shared/search-extract'
import {
  compileSearchFilter,
  countFilterSelections,
  DIRECTOR_KINDS,
  expandKindGroups,
  ftsPhrase,
  hasActiveSearchFilter,
  kindGroupOf,
  localDateRangeToUtc,
  matchesSearchDocument,
  normalizeStoredTimestamp,
  recentLocalDays,
  resolveSearchModel,
  textMatches,
  utcBoundToLocalDate,
  type CompiledSearch
} from '../src/shared/search-query'
import type { ImageSearchFilter } from '../src/shared/types'

function compiled(filter: ImageSearchFilter): CompiledSearch {
  const search = compileSearchFilter(filter)
  if (!search) throw new Error('expected an active filter')
  return search
}

describe('compileSearchFilter', () => {
  it('treats an empty filter as no filter', () => {
    expect(compileSearchFilter(null)).toBeNull()
    expect(compileSearchFilter({})).toBeNull()
    expect(compileSearchFilter({ query: '   ', artists: [], kinds: [] })).toBeNull()
    expect(hasActiveSearchFilter({ query: ' , ' })).toBe(false)
    expect(hasActiveSearchFilter({ favoritesOnly: true })).toBe(true)
  })

  it('parses keywords, exclusions, phrases and inline operators', () => {
    const search = compiled({
      query:
        'Blue_Eyes, -smile "artist:not a key" artist:WLOP char:아리스 seed:42 model:v5-medium -model:v3 kind:inpaint -kind:director'
    })
    expect(search.terms).toEqual([
      { field: 'any', text: 'blue eyes', negate: false },
      { field: 'any', text: 'smile', negate: true },
      { field: 'any', text: 'artist:not a key', negate: false },
      { field: 'artist', text: 'wlop', negate: false },
      { field: 'character', text: '아리스', negate: false }
    ])
    expect(search.seed).toBe(42)
    expect(search.models).toEqual(['nai-diffusion-5-full-medium'])
    expect(search.excludedModels).toEqual(['nai-diffusion-3'])
    expect(search.kinds).toEqual(['inpaint'])
    expect(search.excludedKinds).toEqual([...DIRECTOR_KINDS])
  })

  it('reads a lone long number as seed-or-text', () => {
    expect(compiled({ query: '1234567890' })).toMatchObject({ seedOrText: 1234567890, terms: [] })
    // 짧은 숫자는 일반 검색어 (1girl 같은 토큰과 섞이는 경우)
    expect(compiled({ query: '42' })).toMatchObject({
      seedOrText: null,
      terms: [{ field: 'any', text: '42', negate: false }]
    })
    // 시드 범위 밖이면 시드로 보지 않는다
    expect(compiled({ query: '9999999999' }).seedOrText).toBeNull()
  })

  it('merges popover values with the query', () => {
    const search = compiled({
      query: 'artist:wlop',
      artists: ['WLOP', 'Mika Pikazo'],
      characters: ['Arisu'],
      models: ['nai-diffusion-5-full'],
      kinds: ['t2i', 'director'],
      seed: 7,
      dateFromUtc: '2026-01-01 00:00:00',
      favoritesOnly: true
    })
    expect(search.terms.filter((t) => t.field === 'artist').map((t) => t.text)).toEqual([
      'wlop',
      'mika pikazo'
    ])
    expect(search.kinds).toEqual(['t2i', ...DIRECTOR_KINDS])
    expect(search).toMatchObject({
      seed: 7,
      dateFromUtc: '2026-01-01 00:00:00',
      dateToUtc: null,
      favoritesOnly: true
    })
  })

  it('counts popover selections without the query', () => {
    expect(
      countFilterSelections({
        query: 'anything',
        models: ['a', 'b'],
        kinds: ['t2i'],
        seed: 0,
        dateToUtc: '2026-01-01 23:59:59',
        favoritesOnly: true
      })
    ).toBe(6)
  })
})

describe('kinds and models', () => {
  it('groups director tools and local edits under director', () => {
    expect(kindGroupOf('bg-removal')).toBe('director')
    expect(kindGroupOf('pixelate')).toBe('director')
    expect(kindGroupOf('scene')).toBe('scene')
    expect(kindGroupOf('something-else')).toBeNull()
    expect(expandKindGroups(['upscale', 'director'])).toEqual(['upscale', ...DIRECTOR_KINDS])
  })

  it('resolves model aliases and raw API ids', () => {
    expect(resolveSearchModel('V5')).toBe('nai-diffusion-5-full')
    expect(resolveSearchModel('v5-curated')).toBe('nai-diffusion-5-curated')
    expect(resolveSearchModel('v4.5-full')).toBe('nai-diffusion-4-5-full')
    expect(resolveSearchModel('nai-diffusion-9-test')).toBe('nai-diffusion-9-test')
    expect(resolveSearchModel('furry')).toBeNull()
  })
})

describe('FTS phrases', () => {
  it('builds a prefix phrase from alphanumeric tokens only', () => {
    expect(ftsPhrase('blue eye')).toBe('"blue eye"*')
    expect(ftsPhrase('wlop', 'artist_text')).toBe('artist_text : "wlop"*')
    // FTS5 문법 문자는 토큰이 되지 못한다
    expect(ftsPhrase('a" or b*')).toBe('"a or b"*')
    expect(ftsPhrase('"*()')).toBeNull()
  })
})

describe('dates', () => {
  it('round-trips a local date range through UTC bounds', () => {
    const range = localDateRangeToUtc('2026-03-05', '2026-03-07')
    expect(range.dateFromUtc).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(utcBoundToLocalDate(range.dateFromUtc)).toBe('2026-03-05')
    expect(utcBoundToLocalDate(range.dateToUtc)).toBe('2026-03-07')
    expect(String(range.dateFromUtc) < String(range.dateToUtc)).toBe(true)
    expect(localDateRangeToUtc('', 'bad')).toEqual({ dateFromUtc: null, dateToUtc: null })
    expect(utcBoundToLocalDate(null)).toBe('')
  })

  it('computes recent-day presets ending today', () => {
    const now = new Date(2026, 2, 10, 15, 30)
    expect(recentLocalDays(1, now)).toEqual({ from: '2026-03-10', to: '2026-03-10' })
    expect(recentLocalDays(7, now)).toEqual({ from: '2026-03-04', to: '2026-03-10' })
    expect(recentLocalDays(30, now)).toEqual({ from: '2026-02-09', to: '2026-03-10' })
  })

  it('normalizes ISO timestamps to the SQLite format', () => {
    expect(normalizeStoredTimestamp('2026-03-05 01:02:03')).toBe('2026-03-05 01:02:03')
    expect(normalizeStoredTimestamp('2026-03-05T01:02:03.456Z')).toBe('2026-03-05 01:02:03')
  })
})

describe('in-memory matcher', () => {
  const doc = (overrides: Partial<SearchDocument> = {}): SearchDocument => ({
    ...searchDocumentFromPayload(
      JSON.stringify({
        input: '1girl, artist:wlop, blue_eyes, long hair',
        model: 'nai-diffusion-5-full',
        nais3: { characterNames: ['아리스'] }
      }),
      { kind: 't2i', seed: 1234567 }
    ),
    ...overrides
  })
  const at = { createdAt: '2026-03-05 12:00:00' }
  const matches = (filter: ImageSearchFilter, d = doc(), context = at): boolean =>
    matchesSearchDocument(d, compiled(filter), context)

  it('matches ASCII terms as prefix phrases and other text as substrings', () => {
    expect(textMatches(['blue eyes, long hair'], 'blue ey')).toBe(true)
    expect(textMatches(['blue eyes, long hair'], 'eyes long')).toBe(true)
    expect(textMatches(['blue eyes'], 'lue')).toBe(false)
    expect(textMatches(['아리스, girl'], '리스')).toBe(true)
  })

  it('applies keywords, exclusions and fields', () => {
    expect(matches({ query: 'blue eyes' })).toBe(true)
    expect(matches({ query: 'blue -long' })).toBe(false)
    expect(matches({ query: 'artist:wlop' })).toBe(true)
    expect(matches({ query: 'artist:long' })).toBe(false)
    expect(matches({ query: 'char:아리스' })).toBe(true)
    expect(matches({ query: '-char:아리스' })).toBe(false)
  })

  it('applies model, kind, seed, date and favorites', () => {
    expect(matches({ models: ['nai-diffusion-5-full'] })).toBe(true)
    expect(matches({ models: ['nai-diffusion-5-full-medium'] })).toBe(false)
    expect(matches({ query: '-model:v5' })).toBe(false)
    expect(matches({ kinds: ['t2i'] })).toBe(true)
    expect(matches({ kinds: ['director'] })).toBe(false)
    expect(matches({ kinds: ['director'] }, doc({ kind: 'mosaic' }))).toBe(true)
    expect(matches({ seed: 1234567 })).toBe(true)
    expect(matches({ query: '1234567' })).toBe(true)
    expect(matches({ query: '7654321' })).toBe(false)
    expect(matches({ dateFromUtc: '2026-03-05 00:00:00', dateToUtc: '2026-03-05 23:59:59' })).toBe(
      true
    )
    expect(matches({ dateFromUtc: '2026-03-06 00:00:00' })).toBe(false)
    expect(matches({ favoritesOnly: true })).toBe(false)
    expect(matches({ favoritesOnly: true }, doc(), { ...at, favorite: true })).toBe(true)
  })

  it('lets library keywords match the stack name', () => {
    const plain = doc({ promptText: '', artistText: '', characterText: '', nameText: 'a.png' })
    expect(matches({ query: 'cover' }, plain, { ...at, stackName: 'Cover Candidates' })).toBe(true)
    expect(matches({ query: 'cover' }, plain, { ...at, stackName: null })).toBe(false)
  })
})
