import type Database from 'better-sqlite3'
import { allocateSeq } from '../db/history'
import {
  pathKey,
  registerMedia,
  type MediaRootKind,
  type MediaRootStatus,
  type RegistrationSource
} from '../db/media'

// electron에 의존하지 않는다 — 복사본 폴더 경로·파일 쓰기는 repo.ts가 맡는다

/**
 * .nais의 미디어 원장 (data/ledger.json). 사용자 선택(숨김, 비우기 경계, 씬 귀속)과 외부 복사본을
 * 담는다. 복원은 바꿔치기가 아니라 합치기다:
 * - 루트: 이 기기에 같은 경로의 루트가 있으면 그 루트, 없으면 unmapped로 더한다 (활성 루트가 아니다).
 * - 등록: 위치(루트, 상대 경로)로 중복을 거른다. 새 등록은 이 기기의 새 순번 — 아카이브 순서대로.
 *   이미 있는 등록은 순번·숨김을 그대로 두고, 복원으로 비워진 씬 귀속만 되살린다.
 * - 숨김은 더하기만 한다 (풀지 않는다). 아카이브에서 비우기 경계 아래였던 새 등록은 히스토리에서 숨긴다.
 * - history_state는 바꾸지 않는다 — next_seq가 뒤로 가면 안 된다.
 * - 외부 복사본은 파일까지 담는다. 복원하면 이 기기의 복사본 폴더에 쓰고 거기에 등록한다.
 * 같은 기기에 복원하면 아무것도 바뀌지 않는다
 */

export interface LedgerRoot {
  id: number
  kind: MediaRootKind
  path: string
  status: MediaRootStatus
}

export interface LedgerRegistration {
  seq: number
  rootId: number
  relPath: string
  source: RegistrationSource
  sceneId: number | null
  createdAt: string
  hidden: ('history' | 'scene')[]
}

export interface LedgerSceneSource {
  sceneId: number
  rootId: number
  relDir: string
  role: 'write' | 'read'
}

export interface BackupLedger {
  roots: LedgerRoot[]
  clearedSeq: number
  registrations: LedgerRegistration[]
  sceneSources: LedgerSceneSource[]
}

/** 외부 복사본 파일 — 아카이브 순번(seq)으로 등록과 짝짓는다 */
export interface LedgerFile {
  seq: number
  extension: string
  data: Buffer
}

const KINDS: readonly string[] = ['output', 'scene', 'external']
const STATUSES: readonly string[] = ['current', 'past', 'unmapped']
const SOURCES: readonly string[] = ['generated', 'external', 'manual', 'reindex', 'reclaim']
const SCOPES: readonly string[] = ['history', 'scene']

export function captureLedger(db: Database.Database): BackupLedger {
  const roots = db
    .prepare('SELECT id, kind, path, status FROM media_roots ORDER BY id')
    .all() as LedgerRoot[]
  const clearedSeq = db
    .prepare('SELECT cleared_seq FROM history_state WHERE id = 1')
    .pluck()
    .get() as number
  const registrations = (
    db
      .prepare(
        `SELECT r.seq, r.root_id AS rootId, r.rel_path AS relPath, r.source, r.scene_id AS sceneId,
                r.created_at AS createdAt,
                (SELECT json_group_array(scope) FROM media_hidden h WHERE h.seq = r.seq) AS hidden
         FROM media_registrations r ORDER BY r.seq`
      )
      .all() as (Omit<LedgerRegistration, 'hidden'> & { hidden: string })[]
  ).map((r) => ({ ...r, hidden: JSON.parse(r.hidden) as LedgerRegistration['hidden'] }))
  const sceneSources = db
    .prepare(
      `SELECT scene_id AS sceneId, root_id AS rootId, rel_dir AS relDir, role
       FROM scene_sources ORDER BY id`
    )
    .all() as LedgerSceneSource[]
  return { roots, clearedSeq, registrations, sceneSources }
}

function fail(message: string): never {
  throw new Error(`data/ledger.json ${message}`)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** 상대 경로는 '/'로 잇고 루트 밖으로 나가지 않는다 — 복사본을 쓸 때 경로가 된다 */
function isSafeRelPath(value: unknown, allowEmpty: boolean): value is string {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) return false
  if (value === '') return allowEmpty
  return (
    !value.startsWith('/') &&
    !/^[a-zA-Z]:/.test(value) &&
    value.split('/').every((p) => p && p !== '.' && p !== '..')
  )
}

/** 아카이브에서 읽은 값을 검사한다. 참조가 맞지 않으면 복원하지 않는다 */
export function parseLedger(value: unknown): BackupLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must contain an object')
  const raw = value as Record<string, unknown>
  if (
    !Array.isArray(raw.roots) ||
    !Array.isArray(raw.registrations) ||
    !Array.isArray(raw.sceneSources)
  )
    fail('is missing a list')
  if (!isInteger(raw.clearedSeq)) fail('has an invalid clearedSeq')
  const rootIds = new Set<number>()
  const roots = raw.roots.map((r: Record<string, unknown>): LedgerRoot => {
    if (
      !r ||
      !isInteger(r.id) ||
      rootIds.has(r.id) ||
      typeof r.kind !== 'string' ||
      !KINDS.includes(r.kind) ||
      typeof r.path !== 'string' ||
      !r.path ||
      typeof r.status !== 'string' ||
      !STATUSES.includes(r.status)
    )
      fail('has an invalid root')
    rootIds.add(r.id)
    return {
      id: r.id,
      kind: r.kind as MediaRootKind,
      path: r.path,
      status: r.status as MediaRootStatus
    }
  })
  const seqs = new Set<number>()
  const registrations = raw.registrations.map((r: Record<string, unknown>): LedgerRegistration => {
    if (
      !r ||
      !isInteger(r.seq) ||
      seqs.has(r.seq) ||
      !isInteger(r.rootId) ||
      !rootIds.has(r.rootId) ||
      !isSafeRelPath(r.relPath, false) ||
      typeof r.source !== 'string' ||
      !SOURCES.includes(r.source) ||
      (r.sceneId !== null && !isInteger(r.sceneId)) ||
      typeof r.createdAt !== 'string' ||
      !Array.isArray(r.hidden) ||
      !r.hidden.every((s) => typeof s === 'string' && SCOPES.includes(s))
    )
      fail('has an invalid registration')
    seqs.add(r.seq)
    return {
      seq: r.seq,
      rootId: r.rootId,
      relPath: r.relPath,
      source: r.source as RegistrationSource,
      sceneId: r.sceneId as number | null,
      createdAt: r.createdAt,
      hidden: r.hidden as LedgerRegistration['hidden']
    }
  })
  const sceneSources = raw.sceneSources.map((s: Record<string, unknown>): LedgerSceneSource => {
    if (
      !s ||
      !isInteger(s.sceneId) ||
      !isInteger(s.rootId) ||
      !rootIds.has(s.rootId) ||
      !isSafeRelPath(s.relDir, true) ||
      (s.role !== 'write' && s.role !== 'read')
    )
      fail('has an invalid scene source')
    return { sceneId: s.sceneId, rootId: s.rootId, relDir: s.relDir, role: s.role }
  })
  return { roots, clearedSeq: raw.clearedSeq, registrations, sceneSources }
}

/** 아카이브 루트 id → 이 기기의 루트 id. 같은 경로면 그 루트, 없으면 unmapped로 더한다 */
function mapRoots(db: Database.Database, roots: LedgerRoot[]): Map<number, number> {
  const mapped = new Map<number, number>()
  const find = db.prepare('SELECT id FROM media_roots WHERE path = ?').pluck()
  const insert = db
    .prepare(
      `INSERT INTO media_roots (kind, path, path_key, status) VALUES (?, ?, ?, 'unmapped') RETURNING id`
    )
    .pluck()
  for (const root of roots) {
    const local = find.get(root.path) as number | undefined
    mapped.set(root.id, local ?? (insert.get(root.kind, root.path, pathKey(root.path)) as number))
  }
  return mapped
}

export interface LedgerMergeResult {
  /** 새로 더한 등록 (외부 복사본 포함) */
  registered: number
}

/**
 * 원장을 합친다 — 복원 트랜잭션 안에서, 테이블(gen_scenes 포함)을 넣은 뒤에.
 * copies: 이 기기에 쓴 외부 복사본 (아카이브 seq → 복사본 폴더 루트 안의 상대 경로)
 */
export function mergeLedger(
  db: Database.Database,
  ledger: BackupLedger,
  copies: { rootId: number; relPaths: Map<number, string> }
): LedgerMergeResult {
  const roots = mapRoots(db, ledger.roots)
  const hide = db.prepare('INSERT OR IGNORE INTO media_hidden (seq, scope) VALUES (?, ?)')
  const existingSeq = db
    .prepare('SELECT seq FROM media_registrations WHERE root_id = ? AND rel_path = ?')
    .pluck()
  const restoreScene = db.prepare(
    `UPDATE media_registrations SET scene_id = (SELECT id FROM gen_scenes WHERE id = ?)
     WHERE root_id = ? AND rel_path = ? AND scene_id IS NULL`
  )
  const addSource = db.prepare(
    `INSERT OR IGNORE INTO scene_sources (scene_id, root_id, rel_dir, dir_key, role)
     SELECT id, ?, ?, ?, ? FROM gen_scenes WHERE id = ?`
  )
  let registered = 0
  for (const r of ledger.registrations) {
    const copy = copies.relPaths.get(r.seq)
    const locator =
      copy !== undefined
        ? { rootId: copies.rootId, relPath: copy }
        : { rootId: roots.get(r.rootId) as number, relPath: r.relPath }
    let seq = existingSeq.get(locator.rootId, locator.relPath) as number | undefined
    if (seq !== undefined) {
      // 같은 파일 — 순번·숨김은 이 기기 그대로. gen_scenes를 바꾸면서 비워진 씬 귀속만 되살린다
      if (r.sceneId != null) {
        restoreScene.run(r.sceneId, locator.rootId, locator.relPath)
        const relDir = locator.relPath.includes('/')
          ? locator.relPath.slice(0, locator.relPath.lastIndexOf('/'))
          : ''
        addSource.run(locator.rootId, relDir, pathKey(relDir), 'read', r.sceneId)
      }
    } else {
      seq = registerMedia(db, {
        ...locator,
        seq: allocateSeq(db),
        source: r.source,
        sceneId: r.sceneId
      }).seq
      registered++
      // 아카이브에서 비운 히스토리 아래였다 — 이 기기의 새 순번은 경계 위라 숨겨야 다시 나타나지 않는다
      if (r.seq <= ledger.clearedSeq) hide.run(seq, 'history')
    }
    for (const scope of r.hidden) hide.run(seq, scope)
  }
  const setRole = db.prepare(
    'UPDATE scene_sources SET role = ? WHERE scene_id = ? AND root_id = ? AND rel_dir = ?'
  )
  for (const s of ledger.sceneSources) {
    const rootId = roots.get(s.rootId) as number
    addSource.run(rootId, s.relDir, pathKey(s.relDir), s.role, s.sceneId)
    setRole.run(s.role, s.sceneId, rootId, s.relDir)
  }
  return { registered }
}
