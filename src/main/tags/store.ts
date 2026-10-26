import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, readFileSync, renameSync, rmSync } from 'fs'
import { gunzipSync } from 'zlib'

// electron에 의존하지 않는다 — 메인 스레드(tags/index.ts)와 생성 워커(build.worker.ts),
// 테스트가 같이 쓴다

export interface TagEntry {
  tag: string
  count: number
  type: string
}

/** 스키마·정렬 규칙을 바꾸면 올린다 — 캐시 파일 이름에 들어가 기존 캐시를 무효화한다 */
export const TAGS_DB_SCHEMA = 1

export interface TagsBuildWorkerData {
  source: string
  destination: string
}

export type TagsBuildWorkerMessage = { type: 'done' } | { type: 'error'; message: string }

/** 원본 파일 내용의 sha256 — 스트림으로 읽어 18MB를 한 번에 메모리에 올리지 않는다 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** tags.json 또는 gzip 압축본(.gz) 읽기 */
function readSource(source: string): { value: string; count: number; type: string }[] {
  const buf = readFileSync(source)
  const text = source.endsWith('.gz') ? gunzipSync(buf).toString('utf-8') : buf.toString('utf-8')
  return JSON.parse(text)
}

/**
 * 원본 JSON으로 읽기 전용 태그 DB 생성.
 * 임시 파일에 다 쓴 뒤 rename — 도중에 종료돼도 destination에 반쯤 만든 파일이 남지 않는다.
 */
export function buildTagsDb(source: string, destination: string): void {
  // count 내림차순 안정 정렬 순번을 rowid(rank)로 둔다 — ORDER BY rank가 기존 배열 순서와 같다
  const sorted = readSource(source)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.count - a.t.count || a.i - b.i)
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    const db = new Database(temporary)
    try {
      // 실패하면 통째로 버리는 파일이라 저널·동기화가 필요 없다
      db.pragma('journal_mode = OFF')
      db.pragma('synchronous = OFF')
      db.exec(
        'CREATE TABLE tags (rank INTEGER PRIMARY KEY, tag TEXT NOT NULL, count INTEGER NOT NULL, type TEXT NOT NULL)'
      )
      const insert = db.prepare('INSERT INTO tags (rank, tag, count, type) VALUES (?, ?, ?, ?)')
      db.transaction(() => {
        sorted.forEach(({ t }, rank) => insert.run(rank, t.value, t.count, t.type))
      })()
      // 인덱스는 다 넣은 뒤에 — 행마다 갱신하는 것보다 빠르다
      db.exec('CREATE INDEX idx_tags_tag ON tags (tag)')
      db.exec('ANALYZE')
    } finally {
      db.close()
    }
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function openTagsDb(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  // 검색은 앞쪽(인기순) 몇 페이지만 읽는다 — 기본 2MB 페이지 캐시면 충분
  db.pragma('cache_size = -2048')
  return db
}

/** 기존 검색과 같은 정규화: 앞뒤 공백 제거, 소문자, `_` → 공백 */
export function normalizeTagQuery(query: string): string {
  return query.trim().toLowerCase().replace(/_/g, ' ')
}

/**
 * q로 시작하는 문자열의 바로 다음 상한 (q <= tag < 상한 ⇔ tag가 q로 시작).
 * SQLite BINARY 비교는 UTF-8 바이트 순 = 코드 포인트 순이라 마지막 코드 포인트를 하나 올린다.
 * 올릴 수 없으면(전부 U+10FFFF) null — 상한 없음.
 */
export function prefixUpperBound(q: string): string | null {
  const points = Array.from(q, (c) => c.codePointAt(0)!)
  while (points.length > 0) {
    let last = points.pop()! + 1
    if (last > 0x10ffff) continue
    if (last >= 0xd800 && last <= 0xdfff) last = 0xe000 // 서로게이트 영역은 문자가 아니다
    return String.fromCodePoint(...points, last)
  }
  return null
}

type Statement = Database.Statement<unknown[], TagEntry>
const statements = new WeakMap<Database.Database, Record<'prefix' | 'open' | 'sub', Statement>>()

function prepare(db: Database.Database): Record<'prefix' | 'open' | 'sub', Statement> {
  let s = statements.get(db)
  if (!s) {
    const cols = 'SELECT tag, count, type FROM tags'
    s = {
      // 접두사: idx_tags_tag 범위 스캔 후 rank 정렬
      prefix: db.prepare(`${cols} WHERE tag >= ? AND tag < ? ORDER BY rank LIMIT ?`),
      open: db.prepare(`${cols} WHERE tag >= ? ORDER BY rank LIMIT ?`),
      // 부분 일치(접두사 제외): rank(rowid) 순으로 훑다가 limit개 차면 멈춘다.
      // LIKE 대신 instr — 와일드카드(%, _, \)가 없어 이스케이프가 필요 없고, LIKE와 달리
      // 대소문자를 구분해 기존 String.includes와 같다
      sub: db.prepare(`${cols} WHERE instr(tag, ?) > 1 ORDER BY rank LIMIT ?`)
    }
    statements.set(db, s)
  }
  return s
}

/**
 * 기존 메모리 검색과 같은 결과·순서: 인기순 접두사 일치를 limit개까지, 남은 자리는
 * 인기순 부분 일치로 채운다.
 */
export function searchTagsDb(db: Database.Database, query: string, limit = 8): TagEntry[] {
  const q = normalizeTagQuery(query)
  if (q.length < 2) return []
  // 기존 slice(0, limit)과 같게: 소수는 버리고 0 이하·NaN은 빈 결과, Infinity는 제한 없음
  const n = Number.isNaN(limit) ? 0 : Math.trunc(limit)
  if (n <= 0) return []
  const sqlLimit = (k: number): number => (Number.isFinite(k) ? k : -1)

  const s = prepare(db)
  const upper = prefixUpperBound(q)
  const prefix = upper === null ? s.open.all(q, sqlLimit(n)) : s.prefix.all(q, upper, sqlLimit(n))
  if (prefix.length >= n) return prefix
  return [...prefix, ...s.sub.all(q, sqlLimit(n - prefix.length))]
}
