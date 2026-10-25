import type Database from 'better-sqlite3'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { allocateSeq } from './history'

// electron에 의존하지 않는다 — 경로는 부르는 쪽(storage.ts)이 설정에서 읽어 넘긴다

/**
 * 미디어 루트와 등록 원장.
 * - 파일 위치는 (root_id, 원문 상대 경로)로 가리킨다. 상대 경로는 '/'로 잇고 원문 그대로 둔다.
 * - NFC(path_key)는 조회 키일 뿐이다. NFC가 같고 원문이 다른 두 경로는 다른 파일일 수 있어
 *   합치지 않고 보고만 한다 (mediaCollisions).
 * - 루트는 지우지 않는다. 오프라인·언마운트된 루트도 잃어버린 것으로 보지 않는다 — 여기 함수는
 *   파일 시스템을 보지 않고, 행을 지우지 않는다.
 */

export type MediaRootKind = 'output' | 'scene' | 'external'
export type MediaRootStatus = 'current' | 'past' | 'unmapped'
export type RegistrationSource = 'generated' | 'external' | 'manual' | 'reindex' | 'reclaim'

export interface MediaRoot {
  id: number
  kind: MediaRootKind
  path: string
  status: MediaRootStatus
}

export interface MediaLocator {
  rootId: number
  /** 원문 상대 경로, '/' 구분 */
  relPath: string
}

/** NFC 조회 키 */
export function pathKey(path: string): string {
  return path.normalize('NFC')
}

// Windows는 대소문자를 가리지 않는다 (path.relative도 그렇게 비교한다) — 조회 맵만 접는다
function lookupKey(path: string): string {
  const key = pathKey(path)
  return process.platform === 'win32' ? key.toLowerCase() : key
}

// ── 루트 목록 캐시 ─────────────────────────────────────────────
// 프로토콜 요청마다 isUnderImagesRoot가 부른다. media_roots는 이 파일의 함수로만 바뀐다 —
// 바꾸는 곳마다 비운다. 다른 DB(복원 뒤 다시 연 연결)면 다시 읽는다

interface RootIndex {
  db: Database.Database
  roots: MediaRoot[]
  byPath: Map<string, MediaRoot>
  byKey: Map<string, MediaRoot>
}

let rootIndex: RootIndex | null = null

function invalidateRoots(): void {
  rootIndex = null
}

/** 루트를 넣다가 롤백되면 캐시에 커밋되지 않은 루트가 남는다 — 실패하면 비운다 */
function rollbackSafe<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    invalidateRoots()
    throw error
  }
}

function roots(db: Database.Database): RootIndex {
  if (rootIndex?.db === db) return rootIndex
  const list = db
    .prepare('SELECT id, kind, path, status FROM media_roots ORDER BY id')
    .all() as MediaRoot[]
  const byPath = new Map<string, MediaRoot>()
  const byKey = new Map<string, MediaRoot>()
  for (const root of list) {
    byPath.set(root.path, root)
    // NFC가 겹치는 루트는 먼저 등록된 쪽 — 원문이 정확히 같은 루트가 항상 먼저 잡힌다
    if (!byKey.has(lookupKey(root.path))) byKey.set(lookupKey(root.path), root)
  }
  rootIndex = { db, roots: list, byPath, byKey }
  return rootIndex
}

/** 읽기를 허용하는 루트 — 지금·이전 저장 폴더와 외부 복사본. 다른 기기 경로(unmapped)는 빼고 */
export function readableRoots(db: Database.Database): MediaRoot[] {
  return roots(db).roots.filter((r) => r.status !== 'unmapped')
}

function insertRoot(
  db: Database.Database,
  kind: MediaRootKind,
  path: string,
  status: MediaRootStatus
): MediaRoot {
  const id = db
    .prepare(
      'INSERT INTO media_roots (kind, path, path_key, status) VALUES (?, ?, ?, ?) RETURNING id'
    )
    .pluck()
    .get(kind, path, pathKey(path), status) as number
  invalidateRoots()
  return { id, kind, path, status }
}

/**
 * 지금 저장 폴더를 current로 맞춘다. 저장 폴더를 바꾸면 새 루트가 생기고 예전 루트는 past가 된다.
 * 예전 루트의 경로를 바꾸지 않는다(재연결은 사용자가 폴더를 실제로 옮겼을 때만) — 지우지도 않는다.
 * 같은 경로가 이미 있으면 kind가 달라도 그 행을 쓴다 (메인·씬 폴더를 같은 곳으로 고른 경우).
 * 외부 복사본 루트는 건드리지 않는다. 반환: kind별 current 루트 id
 */
export function syncRoots(
  db: Database.Database,
  current: { output: string; scene: string }
): { output: number; scene: number } {
  return rollbackSafe(() =>
    db.transaction(() => {
      const ids = { output: 0, scene: 0 }
      for (const kind of ['output', 'scene'] as const) {
        const path = resolve(current[kind])
        const existing = db
          .prepare('SELECT id, status FROM media_roots WHERE path = ?')
          .get(path) as { id: number; status: MediaRootStatus } | undefined
        if (!existing) {
          ids[kind] = insertRoot(db, kind, path, 'current').id
        } else {
          // 다른 기기에서 복원된(unmapped) 루트라도 이 기기의 저장 폴더와 원문이 같으면 같은 폴더다
          if (existing.status !== 'current') {
            db.prepare("UPDATE media_roots SET status = 'current' WHERE id = ?").run(existing.id)
            invalidateRoots()
          }
          ids[kind] = existing.id
        }
      }
      const demoted = db
        .prepare(
          `UPDATE media_roots SET status = 'past'
         WHERE status = 'current' AND kind IN ('output', 'scene') AND id NOT IN (?, ?)`
        )
        .run(ids.output, ids.scene)
      if (demoted.changes > 0) invalidateRoots()
      return ids
    })()
  )
}

/**
 * 절대 경로 → (root_id, 원문 상대 경로). 가장 깊은 루트가 이긴다. 루트 경로와 원문이 같은 조상을
 * 먼저 찾고, 없으면 NFC로 찾는다 (NFD로 저장된 경로) — 상대 경로는 어느 쪽이든 파일 경로의 원문.
 * 루트 밖이거나 절대 경로가 아니면 null
 */
export function locate(db: Database.Database, filePath: string): MediaLocator | null {
  if (!isAbsolute(filePath)) return null
  const index = roots(db)
  const file = resolve(filePath)
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const root = index.byPath.get(dir) ?? index.byKey.get(lookupKey(dir))
    if (root) return { rootId: root.id, relPath: relative(dir, file).split(sep).join('/') }
    if (dirname(dir) === dir) return null
  }
}

/** 등록된 파일의 절대 경로 (루트 경로 + 원문 상대 경로) */
export function locatorPath(rootPath: string, relPath: string): string {
  return join(rootPath, ...relPath.split('/'))
}

/**
 * 파일 하나를 원장에 올린다. 같은 (root_id, rel_path)가 이미 있으면 그대로 두고 그 seq를 돌려준다
 * (위치로 중복을 거른다 — 순번·숨김은 먼저 등록된 쪽이 유지된다).
 * 씬 파일이면 그 폴더를 씬의 읽기 위치(scene_sources)로 더한다 — 폴더가 아니라 파일마다 귀속한다
 */
export function registerMedia(
  db: Database.Database,
  input: MediaLocator & { seq: number; source: RegistrationSource; sceneId?: number | null }
): { seq: number; created: boolean } {
  const sceneId = input.sceneId ?? null
  const created = db
    .prepare(
      `INSERT INTO media_registrations (seq, root_id, rel_path, path_key, source, scene_id)
       VALUES (?, ?, ?, ?, ?, (SELECT id FROM gen_scenes WHERE id = ?))
       ON CONFLICT (root_id, rel_path) DO NOTHING
       RETURNING seq`
    )
    .pluck()
    .get(input.seq, input.rootId, input.relPath, pathKey(input.relPath), input.source, sceneId) as
    number | undefined
  if (sceneId != null) addSceneSource(db, sceneId, input.rootId, input.relPath)
  if (created !== undefined) return { seq: created, created: true }
  const seq = db
    .prepare('SELECT seq FROM media_registrations WHERE root_id = ? AND rel_path = ?')
    .pluck()
    .get(input.rootId, input.relPath) as number
  return { seq, created: false }
}

function addSceneSource(
  db: Database.Database,
  sceneId: number,
  rootId: number,
  relPath: string
): void {
  const relDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
  // 지워진 씬을 가리키는 옛 행이면 건너뛴다 (INSERT OR IGNORE는 외래 키 위반을 거르지 않는다)
  db.prepare(
    `INSERT OR IGNORE INTO scene_sources (scene_id, root_id, rel_dir, dir_key, role)
     SELECT id, ?, ?, ?, 'read' FROM gen_scenes WHERE id = ?`
  ).run(rootId, relDir, pathKey(relDir), sceneId)
}

// ── 저장 의도 ─────────────────────────────────────────────────

/**
 * 출력 파일을 쓰기 직전에 남긴다. 순번도 여기서 잡는다 — 행·등록은 이 순번으로 커밋하고, 커밋하는
 * 트랜잭션에서 forgetIntent. 그 사이에 히스토리를 비우면 이 출력은 경계 아래가 된다
 * (저장 중에 비웠든, 앱이 죽은 뒤 되살렸든 같다)
 */
export function recordIntent(
  db: Database.Database,
  input: MediaLocator & { kind: string; seed: number | null; sceneId?: number | null }
): { id: number; seq: number } {
  return db.transaction(() => {
    const seq = allocateSeq(db)
    const id = db
      .prepare(
        `INSERT INTO media_intents (seq, root_id, rel_path, kind, seed, scene_id)
         VALUES (?, ?, ?, ?, ?, (SELECT id FROM gen_scenes WHERE id = ?)) RETURNING id`
      )
      .pluck()
      .get(
        seq,
        input.rootId,
        input.relPath,
        input.kind,
        input.seed,
        input.sceneId ?? null
      ) as number
    return { id, seq }
  })()
}

export function forgetIntent(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM media_intents WHERE id = ?').run(id)
}

export interface PendingIntent {
  id: number
  seq: number
  rootId: number
  rootPath: string
  relPath: string
  kind: string
  seed: number | null
  sceneId: number | null
}

export function pendingIntents(db: Database.Database): PendingIntent[] {
  return db
    .prepare(
      `SELECT i.id, i.seq, i.root_id AS rootId, r.path AS rootPath, i.rel_path AS relPath,
              i.kind, i.seed, i.scene_id AS sceneId
       FROM media_intents i JOIN media_roots r ON r.id = i.root_id ORDER BY i.id`
    )
    .all() as PendingIntent[]
}

export function isRegistered(db: Database.Database, locator: MediaLocator): boolean {
  return registeredSeq(db, locator) !== undefined
}

/** 그 위치에 등록된 순번. 의도의 순번과 다르면 같은 위치를 먼저 쓴 다른(예전) 출력이다 */
export function registeredSeq(db: Database.Database, locator: MediaLocator): number | undefined {
  return db
    .prepare('SELECT seq FROM media_registrations WHERE root_id = ? AND rel_path = ?')
    .pluck()
    .get(locator.rootId, locator.relPath) as number | undefined
}

/**
 * 새 출력이 이 위치를 쓰면 안 되는지 — 등록됐거나(휴지통으로 보내 파일이 없어도 등록은 남는다)
 * 아직 커밋되지 않은 저장 의도가 잡아 둔 위치
 */
export function isLocatorTaken(db: Database.Database, locator: MediaLocator): boolean {
  return (
    isRegistered(db, locator) ||
    db
      .prepare('SELECT 1 FROM media_intents WHERE root_id = ? AND rel_path = ?')
      .get(locator.rootId, locator.relPath) !== undefined
  )
}

// ── 되찾기 ─────────────────────────────────────────────────────

const MONTH_FOLDER = /^\d{4}-\d{2}$/

/**
 * 어느 루트에도 없는 파일의 루트를 추정해 past로 등록한다. 메인 출력은 그 폴더(YYYY-MM 날짜
 * 폴더면 그 위), 씬 출력은 그 폴더. 같은 경로의 루트가 이미 있으면 그걸 쓴다
 */
function addPastRoot(db: Database.Database, filePath: string, scene: boolean): void {
  const parent = dirname(resolve(filePath))
  const path = !scene && MONTH_FOLDER.test(basename(parent)) ? dirname(parent) : parent
  if (!roots(db).byPath.has(path)) insertRoot(db, scene ? 'scene' : 'output', path, 'past')
}

export interface ReclaimResult {
  /** 새로 등록한 행 */
  registered: number
  /** 다른 행이 같은 위치로 이미 등록돼 건너뛴 행 (합치지 않는다) */
  duplicates: { imageId: number; seq: number; filePath: string; registeredSeq: number }[]
}

/**
 * 원장에 없는 images 행을 등록한다 — 이 버전 전의 출력, 다운그레이드한 옛 앱이 이름 폴더나 이전
 * 루트에 쓴 출력. 매 시작 다시 불러도 된다: 진행을 MAX(id)로 기억하지 않고, 등록이 없는 행을
 * 매번 다시 고른다. seq는 images.seq 그대로라 숨김·비우기 경계가 그대로 따라온다.
 * 파일 시스템은 보지 않는다 (오프라인 루트의 행도 등록된다). 순번이 없는 행은 assignMissingSeqs 뒤에
 */
export function reclaimUnregistered(db: Database.Database): ReclaimResult {
  return rollbackSafe(() =>
    db
      .transaction((): ReclaimResult => {
        const rows = db
          .prepare(
            `SELECT id, seq, file_path, scene_id FROM images
             WHERE seq IS NOT NULL AND file_path NOT GLOB 'memory://*'
               AND NOT EXISTS (SELECT 1 FROM media_registrations r WHERE r.seq = images.seq)
             ORDER BY seq`
          )
          .all() as { id: number; seq: number; file_path: string; scene_id: number | null }[]
        const result: ReclaimResult = { registered: 0, duplicates: [] }
        for (const row of rows) {
          if (!isAbsolute(row.file_path)) continue
          // 어느 루트에도 없으면 루트를 추정해 past로 등록하고 다시 찾는다 (날짜 폴더는 상대 경로에 남는다)
          let locator = locate(db, row.file_path)
          if (!locator) {
            addPastRoot(db, row.file_path, row.scene_id != null)
            locator = locate(db, row.file_path)
          }
          if (!locator) continue
          const { seq, created } = registerMedia(db, {
            ...locator,
            seq: row.seq,
            source: 'reclaim',
            sceneId: row.scene_id
          })
          if (created) result.registered++
          else
            result.duplicates.push({
              imageId: row.id,
              seq: row.seq,
              filePath: row.file_path,
              registeredSeq: seq
            })
        }
        return result
      })
      .immediate()
  )
}

// ── 충돌 보고 ─────────────────────────────────────────────────

export interface MediaCollisions {
  /** NFC가 같고 원문이 다른 루트 경로 */
  roots: string[][]
  /** 같은 루트 안에서 NFC가 같고 원문이 다른 상대 경로 */
  files: { rootId: number; relPaths: string[] }[]
}

/** NFC 키가 겹치는 루트·파일. 합치지 않는다 — 실제로 다른 폴더·파일일 수 있다 */
export function mediaCollisions(db: Database.Database): MediaCollisions {
  const rootGroups = db
    .prepare(`SELECT json_group_array(path) FROM media_roots GROUP BY path_key HAVING COUNT(*) > 1`)
    .pluck()
    .all() as string[]
  const fileGroups = db
    .prepare(
      `SELECT root_id, json_group_array(rel_path) AS rel_paths FROM media_registrations
       GROUP BY root_id, path_key HAVING COUNT(*) > 1`
    )
    .all() as { root_id: number; rel_paths: string }[]
  return {
    roots: rootGroups.map((g) => JSON.parse(g) as string[]),
    files: fileGroups.map((g) => ({
      rootId: g.root_id,
      relPaths: JSON.parse(g.rel_paths) as string[]
    }))
  }
}
