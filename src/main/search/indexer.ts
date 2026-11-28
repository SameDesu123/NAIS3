import type Database from 'better-sqlite3'
import { readFile } from 'fs/promises'
import { searchDocumentFromMetadata, searchDocumentFromPayload } from '../../shared/search-extract'
import type { SearchDocument } from '../../shared/search-extract'
import type { SearchIndexStatus } from '../../shared/types'
import { getDb } from '../db'
import { metadataFromPngText } from '../images/metadata'
import { ensureSearchSchema } from './schema'

/**
 * 검색 색인 쓰기. 새 이미지는 저장 직후 바로 색인하고, 색인 테이블이 생기기 전의 기록·백업 복원으로
 * 들어온 행은 백필이 조금씩 채운다. 색인 실패는 절대 저장을 실패시키지 않는다 — 빠진 행은
 * 다음 백필이 채운다.
 */

const IMAGE_CHUNK = 200
const LIBRARY_CHUNK = 20

let available = false
let running = false
let rerun = false
let progressListener: ((status: SearchIndexStatus) => void) | null = null

/**
 * 열린 DB에 검색 색인 스키마를 보장한다 (initDb 직후). 실패해도(FTS5 없는 빌드 등) 앱은 그대로
 * 뜨고, 검색 필터만 꺼진다 — 목록은 필터 없는 기존 쿼리로 돌아간다.
 */
export function initSearchIndex(): boolean {
  try {
    ensureSearchSchema(getDb())
    available = true
  } catch (error) {
    console.error('Search index is unavailable:', error)
    available = false
  }
  return available
}

export function isSearchAvailable(): boolean {
  return available
}

/** 백필 진행 알림 받을 곳 (ipc의 broadcast) — 순환 import를 피하려고 주입받는다 */
export function setSearchProgressListener(listener: (status: SearchIndexStatus) => void): void {
  progressListener = listener
}

function upsertImageDoc(
  db: Database.Database,
  id: number,
  doc: SearchDocument,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO image_search_meta
       (image_id, kind, model_id, seed, created_at, prompt_text, artist_text, character_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       kind = excluded.kind, model_id = excluded.model_id, seed = excluded.seed,
       created_at = excluded.created_at, prompt_text = excluded.prompt_text,
       artist_text = excluded.artist_text, character_text = excluded.character_text`
  ).run(
    id,
    doc.kind,
    doc.modelId,
    doc.seed,
    createdAt,
    doc.promptText,
    doc.artistText,
    doc.characterText
  )
}

function upsertLibraryDoc(
  db: Database.Database,
  id: number,
  doc: SearchDocument,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO library_search_meta
       (library_image_id, kind, model_id, seed, created_at, name_text, prompt_text, artist_text,
        character_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_image_id) DO UPDATE SET
       kind = excluded.kind, model_id = excluded.model_id, seed = excluded.seed,
       created_at = excluded.created_at, name_text = excluded.name_text,
       prompt_text = excluded.prompt_text, artist_text = excluded.artist_text,
       character_text = excluded.character_text`
  ).run(
    id,
    doc.kind,
    doc.modelId,
    doc.seed,
    createdAt,
    doc.nameText,
    doc.promptText,
    doc.artistText,
    doc.characterText
  )
}

interface ImageSourceRow {
  id: number
  kind: string | null
  seed: number | null
  payload_json: string | null
  created_at: string
}

function imageDoc(row: ImageSourceRow): SearchDocument {
  return searchDocumentFromPayload(row.payload_json, { kind: row.kind, seed: row.seed })
}

/** 히스토리 행 하나를 색인한다 (저장 직후). 실패는 기록만 하고 넘긴다 */
export function indexImage(id: number): void {
  if (!available) return
  try {
    const db = getDb()
    const row = db
      .prepare('SELECT id, kind, seed, payload_json, created_at FROM images WHERE id = ?')
      .get(id) as ImageSourceRow | undefined
    if (row) upsertImageDoc(db, row.id, imageDoc(row), row.created_at)
  } catch (error) {
    console.error('Failed to index a history image for search:', id, error)
  }
}

/**
 * 라이브러리 행 하나를 색인한다 (가져오기 직후). 히스토리에서 끌어온 이미지면 그 기록의 payload를,
 * 아니면 PNG 텍스트 메타를 쓴다.
 */
export function indexLibraryImage(
  id: number,
  source: { buffer: Buffer; name: string; sourcePath?: string }
): void {
  if (!available) return
  try {
    const db = getDb()
    const row = db.prepare('SELECT created_at FROM library_images WHERE id = ?').get(id) as
      { created_at: string } | undefined
    if (!row) return
    const history = source.sourcePath
      ? (db
          .prepare(
            'SELECT id, kind, seed, payload_json, created_at FROM images WHERE file_path = ? ORDER BY id DESC LIMIT 1'
          )
          .get(source.sourcePath) as ImageSourceRow | undefined)
      : undefined
    const doc = history
      ? searchDocumentFromPayload(history.payload_json, {
          kind: history.kind,
          seed: history.seed,
          name: source.name
        })
      : searchDocumentFromMetadata(safeTextMetadata(source.buffer), { name: source.name })
    upsertLibraryDoc(db, id, doc, row.created_at)
  } catch (error) {
    console.error('Failed to index a library image for search:', id, error)
  }
}

function safeTextMetadata(buffer: Buffer): ReturnType<typeof metadataFromPngText> {
  try {
    return metadataFromPngText(buffer)
  } catch {
    return null
  }
}

export function getSearchIndexStatus(): SearchIndexStatus {
  if (!available) return { indexing: false, indexed: 0, total: 0 }
  const db = getDb()
  const count = (sql: string): number => db.prepare(sql).pluck().get() as number
  return {
    indexing: running,
    indexed:
      count('SELECT COUNT(*) FROM image_search_meta') +
      count('SELECT COUNT(*) FROM library_search_meta'),
    total: count('SELECT COUNT(*) FROM images') + count('SELECT COUNT(*) FROM library_images')
  }
}

function notify(): void {
  if (!progressListener) return
  try {
    progressListener(getSearchIndexStatus())
  } catch {
    // DB가 닫히는 중 — 다음 시작 때 이어서 한다
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 색인이 없는 히스토리 행을 위에서부터(최신 먼저) 한 번 훑는다. 행 순회는 rowid 커서 */
async function backfillImages(): Promise<void> {
  const db = getDb()
  const select = db.prepare(
    `SELECT i.id, i.kind, i.seed, i.payload_json, i.created_at FROM images i
     WHERE i.id < ? AND NOT EXISTS (SELECT 1 FROM image_search_meta m WHERE m.image_id = i.id)
     ORDER BY i.id DESC LIMIT ?`
  )
  let cursor = Number.MAX_SAFE_INTEGER
  for (;;) {
    const rows = select.all(cursor, IMAGE_CHUNK) as ImageSourceRow[]
    if (rows.length === 0) return
    db.transaction(() => {
      for (const row of rows) upsertImageDoc(db, row.id, imageDoc(row), row.created_at)
    })()
    cursor = rows[rows.length - 1].id
    notify()
    await yieldToEventLoop()
  }
}

/** 라이브러리 행은 파일을 읽어야 한다 — 읽기는 비동기, 쓰기는 묶음 트랜잭션 */
async function backfillLibrary(): Promise<void> {
  const db = getDb()
  const select = db.prepare(
    `SELECT l.id, l.name, l.file_path, l.created_at FROM library_images l
     WHERE l.id < ? AND NOT EXISTS
       (SELECT 1 FROM library_search_meta m WHERE m.library_image_id = l.id)
     ORDER BY l.id DESC LIMIT ?`
  )
  let cursor = Number.MAX_SAFE_INTEGER
  for (;;) {
    const rows = select.all(cursor, LIBRARY_CHUNK) as {
      id: number
      name: string
      file_path: string
      created_at: string
    }[]
    if (rows.length === 0) return
    const docs: { id: number; doc: SearchDocument; createdAt: string }[] = []
    for (const row of rows) {
      // 파일이 없거나 읽지 못하면 이름만으로 색인한다 — 매번 다시 시도하지 않게
      const buffer = await readFile(row.file_path).catch(() => null)
      const meta = buffer ? safeTextMetadata(buffer) : null
      docs.push({
        id: row.id,
        doc: searchDocumentFromMetadata(meta, { name: row.name }),
        createdAt: row.created_at
      })
    }
    // 읽는 동안 지워진 행은 건너뛴다 (meta만 남으면 삭제 트리거가 치울 수 없다)
    const exists = db.prepare('SELECT 1 FROM library_images WHERE id = ?').pluck()
    db.transaction(() => {
      for (const d of docs) if (exists.get(d.id)) upsertLibraryDoc(db, d.id, d.doc, d.createdAt)
    })()
    cursor = rows[rows.length - 1].id
    notify()
    await yieldToEventLoop()
  }
}

/**
 * 빠진 색인을 채운다. 이미 도는 중이면 끝난 뒤 한 번 더 돈다 (그 사이 복원된 행까지).
 * 앱 시작 후와 백업 가져오기 후에 부른다.
 */
export function startSearchBackfill(): void {
  if (!available) return
  if (running) {
    rerun = true
    return
  }
  running = true
  notify()
  void (async () => {
    try {
      do {
        rerun = false
        await backfillImages()
        await backfillLibrary()
      } while (rerun)
    } catch (error) {
      console.error('Search index backfill stopped:', error)
    } finally {
      running = false
      notify()
    }
  })()
}
