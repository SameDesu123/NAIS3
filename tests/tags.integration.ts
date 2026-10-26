import type Database from 'better-sqlite3'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { build } from 'vite'
import { gzipSync } from 'zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureTagsDb, findTagsSource } from '../src/main/tags/cache'
import {
  buildTagsDb,
  openTagsDb,
  prefixUpperBound,
  searchTagsDb,
  type TagEntry
} from '../src/main/tags/store'

type RawTag = { value: string; count: number; type: string }

/** 기존 구현(메모리 배열 순회) 그대로 — 새 구현의 기준 */
function reference(raw: RawTag[]): (query: string, limit?: number) => TagEntry[] {
  const all = raw
    .map((t) => ({ tag: t.value, count: t.count, type: t.type }))
    .sort((a, b) => b.count - a.count)
  return (query, limit = 8) => searchSorted(all, query, limit)
}

function searchSorted(all: TagEntry[], query: string, limit: number): TagEntry[] {
  const q = query.trim().toLowerCase().replace(/_/g, ' ')
  if (q.length < 2) return []
  const prefix: TagEntry[] = []
  const substring: TagEntry[] = []
  for (const t of all) {
    if (t.tag.startsWith(q)) {
      prefix.push(t)
      if (prefix.length >= limit) break
    } else if (substring.length < limit && t.tag.includes(q)) {
      substring.push(t)
    }
  }
  return [...prefix, ...substring].slice(0, limit)
}

const fixture: RawTag[] = [
  { value: 'very long hair', count: 1_000, type: 'general' },
  { value: 'long sleeves', count: 500, type: 'general' },
  { value: 'long hair', count: 400, type: 'general' },
  // 같은 count — 원본 순서가 유지돼야 한다
  { value: 'longcat', count: 400, type: 'meta' },
  { value: 'blonde hair', count: 300, type: 'general' },
  { value: 'longshot', count: 200, type: 'artist' },
  { value: 'Long Coat', count: 150, type: 'general' },
  { value: '100% orange juice', count: 120, type: 'copyright' },
  { value: 'ichigo 100%', count: 110, type: 'copyright' },
  { value: '1000 hair', count: 105, type: 'general' },
  { value: 'snake_case tag', count: 100, type: 'meta' },
  { value: 'snakeXcase', count: 99, type: 'meta' },
  { value: 'snake case', count: 98, type: 'meta' },
  { value: '\\o/', count: 90, type: 'general' },
  { value: 'double \\o/', count: 80, type: 'general' },
  { value: 'xo/', count: 70, type: 'general' },
  { value: 'ポケモン', count: 60, type: 'copyright' },
  { value: 'ポケットモンスター', count: 55, type: 'copyright' },
  { value: '\u{10FFFF}\u{10FFFF}x', count: 40, type: 'general' },
  { value: 'a\u{10FFFF}', count: 30, type: 'general' },
  { value: 'b', count: 20, type: 'general' },
  { value: 'hair', count: 10, type: 'general' }
]

const queries = [
  '',
  'l',
  ' _ ',
  'lo',
  'long',
  ' LONG_HAIR ',
  'long hair',
  'Long',
  'hair',
  'air',
  '%',
  '100%',
  '%o',
  '0%',
  'snake_case',
  'snake case',
  'e_c',
  'e c',
  '\\o',
  '\\o/',
  'o/',
  '\\',
  '\\\\',
  'ポケ',
  'モン',
  '\u{10FFFF}\u{10FFFF}',
  'a\u{10FFFF}',
  'zz',
  'no such tag'
]
const limits = [undefined, 0, -1, 1, 2, 3, 4, 8, 2.5, 50, Infinity, NaN]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nais3-tags-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function buildFrom(raw: RawTag[], gzip = false): Database.Database {
  const source = join(dir, gzip ? 'tags.json.gz' : 'tags.json')
  const json = Buffer.from(JSON.stringify(raw))
  writeFileSync(source, gzip ? gzipSync(json) : json)
  const path = join(dir, 'tags.db')
  buildTagsDb(source, path)
  return openTagsDb(path)
}

describe('태그 DB 검색이 기존 메모리 검색과 같다', () => {
  it.each([false, true])('픽스처 (gzip=%s)', (gzip) => {
    const db = buildFrom(fixture, gzip)
    const referenceSearch = reference(fixture)
    try {
      for (const q of queries) {
        for (const limit of limits) {
          expect(searchTagsDb(db, q, limit), `${JSON.stringify(q)} limit=${limit}`).toEqual(
            referenceSearch(q, limit)
          )
        }
      }
    } finally {
      db.close()
    }
  })

  it('기존 단위 테스트 사례', () => {
    const db = buildFrom(fixture)
    try {
      const tags = (q: string, limit?: number): string[] =>
        searchTagsDb(db, q, limit).map((t) => t.tag)
      expect(tags('l')).toEqual([])
      expect(tags(' _ ')).toEqual([])
      expect(tags(' LONG_HAIR ')).toEqual(['long hair', 'very long hair'])
      // 더 인기 있는 부분 일치보다 접두사 일치가 먼저
      expect(tags('long')).toEqual([
        'long sleeves',
        'long hair',
        'longcat',
        'longshot',
        'very long hair'
      ])
      expect(tags('long', 2)).toEqual(['long sleeves', 'long hair'])
      // %, _ 는 와일드카드가 아니다
      expect(tags('0%')).toEqual(['100% orange juice', 'ichigo 100%'])
      expect(tags('e_c')).toEqual(['snake case'])
    } finally {
      db.close()
    }
  })

  it('실제 tags.json (32만 개)', () => {
    const raw = JSON.parse(readFileSync(resolve('resources/tags.json'), 'utf-8')) as RawTag[]
    const db = buildFrom(raw)
    const referenceSearch = reference(raw)
    try {
      // 실제 태그에서 뽑은 접두사·중간 조각 + 특수 문자 사례 (고정 시드)
      let seed = 42
      const rand = (n: number): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
        return seed % n
      }
      const sample = [...queries, '1g', 'sa', '(umamusume)', '\\n/', 'zygarde (', 'xqz']
      for (let i = 0; i < 300; i++) {
        const tag = raw[rand(raw.length)].value
        const start = i % 2 === 0 ? 0 : rand(tag.length)
        sample.push(tag.slice(start, start + 2 + rand(6)).replace(/ /g, '_'))
      }
      for (const q of sample) {
        for (const limit of [8, 1, 20]) {
          expect(searchTagsDb(db, q, limit), `${JSON.stringify(q)} limit=${limit}`).toEqual(
            referenceSearch(q, limit)
          )
        }
      }
    } finally {
      db.close()
    }
  }, 60_000)

  it('접두사 검색은 태그 인덱스를 탄다', () => {
    const db = buildFrom(fixture)
    try {
      const plan = (
        db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT tag, count, type FROM tags WHERE tag >= ? AND tag < ? ORDER BY rank LIMIT ?'
          )
          .all('lo', 'lp', 8) as { detail: string }[]
      )
        .map((r) => r.detail)
        .join('\n')
      expect(plan).toContain('idx_tags_tag')
    } finally {
      db.close()
    }
  })
})

describe('prefixUpperBound', () => {
  it('마지막 코드 포인트를 하나 올린다', () => {
    expect(prefixUpperBound('lo')).toBe('lp')
    expect(prefixUpperBound('a\u{D7FF}')).toBe('a\u{E000}')
    expect(prefixUpperBound('a\u{10FFFF}')).toBe('b')
    expect(prefixUpperBound('\u{10FFFF}\u{10FFFF}')).toBeNull()
  })
})

describe('캐시 DB 생성', () => {
  let worker: string
  let bundle: string

  // 앱은 electron-vite 빌드에서 워커를 읽는다 — 같은 엔트리를 Node용으로 번들
  beforeAll(async () => {
    bundle = mkdtempSync(join(tmpdir(), 'nais3-tags-worker-'))
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        ssr: resolve('src/main/tags/build.worker.ts'),
        outDir: bundle,
        rollupOptions: {
          output: {
            format: 'cjs',
            entryFileNames: 'build.worker.cjs',
            paths: { 'better-sqlite3': createRequire(import.meta.url).resolve('better-sqlite3') }
          }
        }
      }
    })
    worker = join(bundle, 'build.worker.cjs')
  })
  afterAll(() => rmSync(bundle, { recursive: true, force: true }))

  const cache = (): string => join(dir, 'cache')
  const writeSource = (raw: RawTag[]): string => {
    const source = join(dir, 'tags.json')
    writeFileSync(source, JSON.stringify(raw))
    return source
  }

  it('압축본이 있으면 그쪽을 원본으로 쓴다', () => {
    writeFileSync(join(dir, 'tags.json'), '[]')
    expect(findTagsSource(dir)).toBe(join(dir, 'tags.json'))
    writeFileSync(join(dir, 'tags.json.gz'), gzipSync('[]'))
    expect(findTagsSource(dir)).toBe(join(dir, 'tags.json.gz'))
  })

  it.each([true, false])(
    '워커(%s)로 만들고, 같은 원본이면 다시 만들지 않는다',
    async (useWorker) => {
      const source = writeSource(fixture)
      const path = await ensureTagsDb(source, cache(), useWorker ? worker : undefined)
      const db = openTagsDb(path)
      try {
        expect(searchTagsDb(db, 'long')).toEqual(reference(fixture)('long'))
      } finally {
        db.close()
      }
      const built = statSync(path).mtimeMs
      expect(await ensureTagsDb(source, cache(), worker)).toBe(path)
      expect(statSync(path).mtimeMs).toBe(built)
    }
  )

  it('원본이 바뀌면 새로 만들고 이전 캐시와 남은 .tmp를 지운다', async () => {
    const first = await ensureTagsDb(writeSource(fixture), cache(), worker)
    writeFileSync(join(cache(), 'tags-v1-dead.db.0000.tmp'), 'partial')
    const changed = [...fixture, { value: 'longest', count: 5_000, type: 'general' }]
    const second = await ensureTagsDb(writeSource(changed), cache(), worker)
    expect(second).not.toBe(first)
    expect(readdirSync(cache())).toEqual([second.slice(cache().length + 1)])
    const db = openTagsDb(second)
    try {
      expect(searchTagsDb(db, 'long')[0].tag).toBe('longest')
    } finally {
      db.close()
    }
  })

  it('생성에 실패하면 반쯤 만든 파일을 남기지 않는다', async () => {
    const source = join(dir, 'tags.json')
    writeFileSync(source, '[{"value": "broken"')
    await expect(ensureTagsDb(source, cache(), worker)).rejects.toThrow()
    expect(readdirSync(cache())).toEqual([])
    // 워커 없이(메인 스레드) 생성해도 같다
    await expect(ensureTagsDb(source, cache())).rejects.toThrow()
    expect(readdirSync(cache())).toEqual([])
    expect(existsSync(join(dir, 'tags.db'))).toBe(false)
  })
})
