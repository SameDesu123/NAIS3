import { randomUUID } from 'crypto'
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative } from 'path'
import { isThumbnailSource, thumbnailUrl, type ThumbnailSource } from '../../shared/thumbnail-url'
import type { DirectorMethod, HistoryItem, ImageMetadata } from '../../shared/types'
import { getDb } from '../db'
import { allocateSeq, historyCount, historySeqs } from '../db/history'
import {
  forgetIntent,
  isLocatorTaken,
  locate,
  locatorPath,
  markSceneWrite,
  pathKey,
  readableRoots,
  recordIntent,
  registerMedia,
  syncRoots,
  type MediaLocator,
  type RegistrationSource
} from '../db/media'
import { getSetting } from '../db/settings'
import { nextNumber, numberedName, safeFileStem } from './file-names'
import { buildNaisMetadata, embedNaisMetadata } from './nais-metadata'
import {
  primeThumbnail,
  renderThumbnail,
  thumbnailForFile,
  type SourceVersion
} from './thumbnail-cache'

/**
 * 생성 이미지 저장 규칙 (P3의 핵심):
 * - 원본 PNG는 디스크 파일로만. base64를 어디에도 상주시키지 않는다.
 * - DB에는 경로·시드·전송 payload 원본·소형 썸네일(webp BLOB)만.
 * - 출력 파일엔 재현 설정을 넣는다 (nais-metadata.ts) — 파일만으로 설정을 되살릴 수 있게.
 */

export interface SavedImage {
  id: number
  filePath: string
}

/** 기본 저장 폴더 (설정 미지정 시) */
export function defaultImagesRoot(): string {
  return join(app.getPath('pictures'), 'NAIS3')
}

/**
 * 메인 모드 저장 폴더.
 * - 미지정: 기본폴더/NAIS3_output
 * - 지정(save_dir): 그 폴더에 바로 쌓임 (하위 폴더 자동 생성 없음 — 유저가 고른 곳 그대로)
 */
export function imagesRoot(): string {
  const custom = getSetting('save_dir')
  return custom && custom.trim() ? custom : join(defaultImagesRoot(), 'NAIS3_output')
}

/** 씬 모드 저장 루트 — 미지정이면 기본폴더/NAIS3_scene, 지정(scene_save_dir)이면 그 폴더 */
export function scenesRoot(): string {
  const custom = getSetting('scene_save_dir')
  return custom && custom.trim() ? custom : join(defaultImagesRoot(), 'NAIS3_scene')
}

/** 앱 내부 라이브러리 폴더 — 자동 저장 OFF일 때 저장 위치 (히스토리엔 남지만 저장 폴더엔 안 감) */
export function libraryRoot(): string {
  return join(app.getPath('userData'), 'library')
}

/** 기존 씬(folder_uuid 없음)의 이름 폴더 — 씬루트/<프리셋>/<씬 이름>/ */
function sceneDir(presetName: string | null, sceneName: string, sceneId?: number): string {
  const safe = (s: string): string => s.replace(/[/\\:*?"<>|]/g, '_').trim()
  return join(scenesRoot(), safe(presetName ?? '') || '기본', safe(sceneName) || `씬-${sceneId}`)
}

export interface SceneFolderInfo {
  id: number
  name: string
  /** NULL = 기존 이름 폴더 씬 */
  folderUuid: string | null
  presetName: string | null
}

export function sceneFolderInfo(sceneId: number | null | undefined): SceneFolderInfo | null {
  if (sceneId == null) return null
  const row = getDb()
    .prepare(
      `SELECT s.id, s.name, s.folder_uuid AS folderUuid, p.name AS presetName
       FROM gen_scenes s LEFT JOIN scene_presets p ON p.id = s.preset_id WHERE s.id = ?`
    )
    .get(sceneId) as SceneFolderInfo | undefined
  return row ?? null
}

/**
 * 씬의 쓰기 폴더 — 새 씬은 지금 씬루트/<uuid>/, 기존 씬은 씬루트/<프리셋>/<씬 이름>/ (옮기지 않는다).
 * 이전에 쓴 폴더(이전 씬 루트, 이름을 바꾸기 전 폴더)는 읽기 위치로 남는다 — scenes/folders.ts
 */
export function sceneWriteDir(scene: SceneFolderInfo): string {
  const uuidDir = sceneUuidDir(scene)
  if (uuidDir) return uuidDir
  if (scene.folderUuid)
    console.warn(`scene ${scene.id} has an unusable folder_uuid; writing to its name folder`)
  return sceneDir(scene.presetName, scene.name, scene.id)
}

/**
 * UUID 폴더 — folder_uuid가 씬 루트 바로 아래 한 칸일 때만 (구분자, 드라이브, '.', '..'가 없다).
 * 아니면(복원·외부 편집) null: 이름 폴더 씬처럼 쓴다
 */
function sceneUuidDir(scene: SceneFolderInfo): string | null {
  const uuid = scene.folderUuid
  if (!uuid || uuid === '.' || uuid === '..' || /[/\\:\0]/.test(uuid)) return null
  const root = scenesRoot()
  const dir = join(root, uuid)
  return isInside(root, dir) ? dir : null
}

type RootIds = ReturnType<typeof syncRoots>
let syncedRoots: { db: unknown; output: string; scene: string; ids: RootIds } | null = null

/**
 * 지금 저장 폴더를 미디어 루트로 맞춘다 (반환: kind별 current 루트 id). 설정이 그대로면 DB를 건드리지
 * 않는다 — 저장마다 부른다. 저장 폴더를 바꾸면 새 루트가 current, 예전 루트는 past로 남는다
 */
export function syncMediaRoots(): RootIds {
  const db = getDb()
  const output = imagesRoot()
  const scene = scenesRoot()
  if (syncedRoots?.db === db && syncedRoots.output === output && syncedRoots.scene === scene)
    return syncedRoots.ids
  const ids = syncRoots(db, { output, scene })
  syncedRoots = { db, output, scene, ids }
  return ids
}

/** parent 디렉터리 안의 경로인지 — path.relative 기반 (Windows 대소문자·구분자·접두 충돌 안전) */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 프로토콜/파일 접근 허용 판정. 저장 폴더를 바꿔도 예전 이미지가 계속 보이도록
 * 현재/기본 저장 폴더, 내부 라이브러리 폴더, 등록된 미디어 루트(이전 저장 폴더 포함)를 허용한다.
 * 읽기·복사용 판정이다 — 파일을 지우는 데 쓰지 않는다
 */
export function isUnderImagesRoot(filePath: string): boolean {
  return (
    isInside(imagesRoot(), filePath) ||
    isInside(scenesRoot(), filePath) ||
    isInside(defaultImagesRoot(), filePath) ||
    isInside(libraryRoot(), filePath) ||
    isUnderMediaRoot(filePath)
  )
}

function isUnderMediaRoot(filePath: string): boolean {
  let db: ReturnType<typeof getDb>
  try {
    db = getDb()
  } catch {
    return false // DB가 열리기 전
  }
  const key = pathKey(filePath)
  return readableRoots(db).some((root) => isInside(pathKey(root.path), key))
}

// ── 자동저장 OFF 임시 이미지 (NAIS2 방식) ──────────────────────
// 원본은 디스크에 안 쓰고 메모리 링버퍼(최근 N장)에만 보관. DB에는 썸네일 행만 남아
// 히스토리에 보이고, 경로는 memory:// 마커. 재시작하면 원본은 사라지고 썸네일로 폴백.

export const MEMORY_PREFIX = 'memory://'
const EPHEMERAL_KEEP = 20
const memoryImages = new Map<string, Buffer>()

export function isMemoryPath(filePath: string): boolean {
  return filePath.startsWith(MEMORY_PREFIX)
}

export function getMemoryImage(filePath: string): Buffer | null {
  return memoryImages.get(filePath) ?? null
}

export function dropMemoryImage(filePath: string): void {
  memoryImages.delete(filePath)
}

/** 원본이 만료됐을 때의 표시 폴백 — DB 썸네일(webp) */
export function thumbnailByPath(filePath: string): Buffer | null {
  const row = getDb().prepare('SELECT thumbnail FROM images WHERE file_path = ?').get(filePath) as
    { thumbnail: Buffer | null } | undefined
  return row?.thumbnail ?? null
}

const THUMBNAIL_TABLES: Record<ThumbnailSource, string> = {
  image: 'images',
  library: 'library_images'
}

/**
 * Resolves a `thumbnailUrl()` request to its bytes (null for bad params or no thumbnail).
 * Output images come from the thumbnail cache, built from the file itself; the stored
 * thumbnail is the fallback for memory images and files that are gone or unreadable.
 */
export async function thumbnailForUrl(url: URL): Promise<Buffer | null> {
  const source = url.searchParams.get('thumb')
  const id = Number(url.searchParams.get('id'))
  if (!isThumbnailSource(source) || !Number.isInteger(id)) return null
  if (source === 'image') return imageThumbnail(id) // id = 순번(seq)
  const row = getDb()
    .prepare(`SELECT thumbnail FROM ${THUMBNAIL_TABLES[source]} WHERE id = ?`)
    .get(id) as { thumbnail: Buffer | null } | undefined
  return row?.thumbnail ?? null
}

export interface ThumbnailRow {
  file_path: string
  created_at: string
  thumbnail: Buffer | null
}

/** 출력 이미지 한 행의 썸네일 — 파일에서 (캐시), 없으면 DB 썸네일 */
export async function rowThumbnail(row: ThumbnailRow): Promise<Buffer | null> {
  if (isMemoryPath(row.file_path)) return row.thumbnail
  const fromFile = await thumbnailForFile(row.file_path, (version) =>
    storedThumbnailFits(row, version) ? row.thumbnail : null
  )
  return fromFile ?? row.thumbnail
}

/** 항목(순번)의 썸네일 — images 행이 있으면 그 행대로, 원장에만 있는 항목은 파일에서 (캐시) */
async function imageThumbnail(seq: number): Promise<Buffer | null> {
  const row = getDb()
    .prepare('SELECT file_path, created_at, thumbnail FROM images WHERE seq = ?')
    .get(seq) as ThumbnailRow | undefined
  if (row) return rowThumbnail(row)
  const reg = registrationsBySeq([seq]).get(seq)
  return reg ? thumbnailForFile(reg.file_path) : null
}

/**
 * 저장 이후 파일이 바뀌지 않았으면 DB 썸네일이 곧 그 파일의 썸네일이다 — 업그레이드 뒤 첫 화면이
 * 원본 수천 장을 디코드하지 않게 캐시를 이걸로 채운다. 파일은 행보다 먼저 쓰이고
 * created_at은 초 단위로 잘리니, 그 뒤로 몇 초 안에 수정된 파일까지만 같다고 본다.
 */
function storedThumbnailFits(row: ThumbnailRow, version: SourceVersion): boolean {
  const created = Date.parse(`${row.created_at.replace(' ', 'T')}Z`)
  return !!row.thumbnail?.length && Number.isFinite(created) && version.mtimeMs < created + 2000
}

/** Protocol URL for a row's stored thumbnail, or '' when it has none (callers fall back to the original) */
export function storedThumbnailUrl(
  source: ThumbnailSource,
  id: number | null | undefined,
  createdAt: string | null | undefined,
  thumbSize: number | null | undefined
): string {
  return id != null && createdAt && thumbSize ? thumbnailUrl(source, id, createdAt, thumbSize) : ''
}

/** 자동저장 OFF 메인 생성 저장 — 파일 없이 메모리 + 썸네일 행. 최근 N장 초과분은 행·버퍼 정리 */
export async function saveEphemeralImage(input: {
  png: Buffer
  sentPayload: string
  seed: number
  kind: 't2i' | 'i2i' | 'inpaint'
  format?: 'png' | 'webp'
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
}): Promise<SavedImage> {
  const ext = input.format ?? 'png'
  const filePath = `${MEMORY_PREFIX}${randomUUID()}.${ext}`
  // 메타데이터 주입본을 캐시에 — "다른 이름으로 저장" 구제 시 파일 저장본과 동일해지게
  memoryImages.set(filePath, withNaisMetadata(input, new Date()))

  // 원본이 메모리에만 있다 — 만료된 뒤엔 이 DB 썸네일이 유일한 표시본
  const thumbnail = await renderThumbnail(input.png)
  const db = getDb()
  const result = db.transaction(() =>
    db
      .prepare(
        'INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id, seq) VALUES (?, ?, ?, ?, ?, NULL, ?)'
      )
      .run(
        filePath,
        thumbnail,
        input.kind,
        input.seed,
        payloadWithLocalMetadata(input.sentPayload, input.localMetadata),
        allocateSeq(db)
      )
  )()

  // GLOB(대소문자 구분)이라야 idx_images_file_path 범위 탐색을 탄다 — LIKE는 전체 스캔
  const stale = db
    .prepare(
      `SELECT id, file_path FROM images WHERE file_path GLOB '${MEMORY_PREFIX}*'
       ORDER BY id DESC LIMIT -1 OFFSET ?`
    )
    .all(EPHEMERAL_KEEP) as { id: number; file_path: string }[]
  if (stale.length > 0) {
    for (const s of stale) memoryImages.delete(s.file_path)
    db.prepare(`DELETE FROM images WHERE id IN (${stale.map(() => '?').join(',')})`).run(
      ...stale.map((s) => s.id)
    )
  }
  return { id: Number(result.lastInsertRowid), filePath }
}

export async function saveGeneratedImage(input: {
  png: Buffer
  sentPayload: string
  seed: number
  // 디렉터 결과는 개별 req_type(bg-removal 등)을 kind로 저장 → 히스토리 뱃지가 툴별로 표시
  kind: 't2i' | 'i2i' | 'inpaint' | 'scene' | 'upscale' | 'director' | 'mosaic' | DirectorMethod
  /** 씬 생성이면 씬 id — 씬 출력인지는 이것만 본다. 그새 지워진 씬이면 메인 폴더에 저장 */
  sceneId?: number
  /** 저장 파일 확장자 (NAI가 반환한 실제 포맷). 기본 png */
  format?: 'png' | 'webp'
  /** 전송 payload에는 없는 NAIS3 전용 왕복 메타데이터 */
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
}): Promise<SavedImage> {
  const now = new Date()
  syncMediaRoots()
  // 여기 오면 항상 실제 폴더에 저장한다. 자동저장 OFF의 "저장 안 함" 판정은
  // 생성 큐 콜백(index.ts)에서 메인 생성만 걸러서 처리 — 씬·디렉터 툴은 항상 저장.
  // 구조: 메인 = 메인폴더/[YYYY-MM/] (날짜 폴더는 설정으로 on/off)
  //       씬 = 씬루트/<uuid>/씬 이름_N (새 씬), 씬루트/<프리셋>/<씬 이름>/ (기존 씬 — 옮기지 않는다)
  const scene = sceneFolderInfo(input.sceneId)
  let dir: string
  let stem: string
  if (scene) {
    dir = sceneWriteDir(scene)
    stem = safeFileStem(scene.name, `씬-${scene.id}`)
  } else {
    const out = imagesRoot()
    dir =
      getSetting('date_folders') !== '0'
        ? join(out, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
        : out
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    stem = `NAIS3_${stamp}_${input.seed}`
  }
  mkdirSync(dir, { recursive: true })

  // UUID 씬은 씬 이름_1부터. 기존 이름 폴더와 메인 출력은 첫 장은 번호 없이, 겹치면 _2, _3 ...
  // (메인 출력은 같은 초에 시드 0인 툴 출력이 겹칠 때만 번호가 붙는다 — 폴더를 읽지 않는다)
  const firstPlain = !scene || !sceneUuidDir(scene)
  const write = writeOutputExclusive({
    dir,
    name: (n) => numberedName(stem, n, input.format ?? 'png', firstPlain),
    firstNumber: scene ? nextNumber(readdirSync(dir), stem, firstPlain) : 1,
    bytes: withNaisMetadata(input, now),
    kind: input.kind,
    seed: input.seed,
    sceneId: scene?.id ?? null
  })

  // 표시는 썸네일 캐시가 맡는다. DB 썸네일은 1.0.29로 되돌렸을 때 히스토리가 비지 않게 계속 쓴다
  // (1.0.29 히스토리는 thumbnail이 NULL이면 타일을 그리지 않는다) — 컬럼 정리는 H에서
  const thumbnail = await renderThumbnail(input.png)
  const id = commitOutput(write, {
    thumbnail,
    kind: input.kind,
    seed: input.seed,
    payload: payloadWithLocalMetadata(input.sentPayload, input.localMetadata),
    sceneId: scene?.id ?? null,
    source: 'generated'
  })
  await primeThumbnail(write.filePath, thumbnail)

  return { id, filePath: write.filePath }
}

/**
 * 휴지통으로 보낸 이미지는 파일이 없어도 images 행이 남는다 — 같은 이름을 다시 쓰면 두 행이 한
 * file_path를 나눠 가져 메타데이터 조회가 옛 행을 읽는다
 */
function hasImageRow(db: ReturnType<typeof getDb>, filePath: string): boolean {
  return db.prepare('SELECT 1 FROM images WHERE file_path = ? LIMIT 1').get(filePath) !== undefined
}

/** 이름을 배타적으로 만들 때 한 파일이 몇 번까지 다음 번호로 넘어가는지 */
const MAX_NAME_ATTEMPTS = 10_000

export interface ExclusiveWrite {
  filePath: string
  locator: MediaLocator | null
  intent: { id: number; seq: number } | null
}

/**
 * 출력 파일을 새 이름으로 쓴다 — 기존 파일을 덮어쓰지 않는다. 후보마다 쓰기 전에 의도와 순번을 남기고
 * 'wx'로 쓴다. 이미 있으면(다른 저장이 먼저 썼으면) 의도를 지우고 다음 번호로. 파일만 쓰이고 등록이
 * 커밋되지 않으면 다음 시작 때 의도의 순번으로 되살린다 (media-recovery.ts)
 */
export function writeOutputExclusive(input: {
  dir: string
  name: (n: number) => string
  firstNumber: number
  bytes: Buffer
  kind: string
  seed: number | null
  sceneId: number | null
}): ExclusiveWrite {
  const db = getDb()
  for (let n = input.firstNumber; n < input.firstNumber + MAX_NAME_ATTEMPTS; n++) {
    const filePath = join(input.dir, input.name(n))
    if (existsSync(filePath) || hasImageRow(db, filePath)) continue
    const locator = locate(db, filePath)
    // 원장의 위치도 본다 — 등록된 위치를 다시 쓰면 등록이 새 출력에 옛 순번을 돌려준다
    if (locator && isLocatorTaken(db, locator)) continue
    const intent = locator
      ? recordIntent(db, { ...locator, kind: input.kind, seed: input.seed, sceneId: input.sceneId })
      : null
    try {
      writeFileSync(filePath, input.bytes, { flag: 'wx' })
      return { filePath, locator, intent }
    } catch (error) {
      if (intent) forgetIntent(db, intent.id)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`No free file name in ${input.dir}`)
}

/**
 * 쓴 파일의 행·등록을 의도의 순번으로 함께 커밋한다. 저장하는 사이에 히스토리를 비웠으면 이 출력도
 * 경계 아래다 — 의도를 남긴 뒤에 비운 것이니 앱이 죽은 뒤 되살릴 때와 같은 순서다.
 * 씬 출력이면 그 폴더가 씬의 쓰기 위치가 된다. 반환: images.id
 */
export function commitOutput(
  write: ExclusiveWrite,
  row: {
    thumbnail: Buffer | null
    kind: string
    seed: number | null
    payload: string
    sceneId: number | null
    source: RegistrationSource
  }
): number {
  const db = getDb()
  return db.transaction(() => {
    const seq = write.intent?.seq ?? allocateSeq(db)
    const inserted = db
      .prepare(
        'INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(write.filePath, row.thumbnail, row.kind, row.seed, row.payload, row.sceneId, seq)
    if (write.locator) {
      const registered = registerMedia(db, {
        ...write.locator,
        seq,
        source: row.source,
        sceneId: row.sceneId
      })
      // 이름을 고를 때 등록된 위치를 피하므로 생기지 않는다. 생기면 옛 순번을 채택하지 않고 롤백한다 —
      // 파일과 의도는 남아 다음 시작 때 복구가 보고한다
      if (!registered.created && registered.seq !== seq)
        throw new Error(`${write.filePath} is already registered as seq ${registered.seq}`)
      if (row.sceneId != null) markSceneWrite(db, row.sceneId, write.locator)
    }
    if (write.intent) forgetIntent(db, write.intent.id)
    return Number(inserted.lastInsertRowid)
  })()
}

function payloadWithLocalMetadata(
  sentPayload: string,
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
): string {
  if (!localMetadata) return sentPayload
  try {
    return JSON.stringify({ ...JSON.parse(sentPayload), nais3: localMetadata })
  } catch {
    return sentPayload
  }
}

/** 출력 파일에 넣을 바이트 — 생성·업스케일·디렉터·로컬 저장 모두 같은 메타데이터를 단다 */
function withNaisMetadata(
  input: {
    png: Buffer
    sentPayload: string
    seed: number
    kind: string
    localMetadata?: Pick<ImageMetadata, 'promptParts'>
  },
  createdAt: Date
): Buffer {
  return embedNaisMetadata(
    input.png,
    buildNaisMetadata({
      sentPayload: input.sentPayload,
      kind: input.kind,
      seed: input.seed,
      createdAt,
      appVersion: app.getVersion(),
      mediaId: randomUUID(),
      localMetadata: input.localMetadata
    })
  )
}

interface HistoryImageRow {
  seq: number
  file_path: string
  thumb_size: number | null
  kind: string
  seed: number | null
  created_at: string
}

export interface HistoryRegistrationRow {
  seq: number
  file_path: string
  source: RegistrationSource
  scene_id: number | null
  created_at: string
}

/** 순번들의 원장 등록 — 이 기기에서 읽을 수 있는(unmapped가 아닌) 루트만, 경로는 루트 + 상대 경로 */
export function registrationsBySeq(seqs: number[]): Map<number, HistoryRegistrationRow> {
  if (seqs.length === 0) return new Map()
  const rows = getDb()
    .prepare(
      `SELECT r.seq, ro.path AS root_path, r.rel_path, r.source, r.scene_id, r.created_at
       FROM media_registrations r JOIN media_roots ro ON ro.id = r.root_id
       WHERE r.seq IN (${seqs.map(() => '?').join(',')}) AND ro.status != 'unmapped'`
    )
    .all(...seqs) as (Omit<HistoryRegistrationRow, 'file_path'> & {
    root_path: string
    rel_path: string
  })[]
  return new Map(
    rows.map((r) => [
      r.seq,
      {
        seq: r.seq,
        file_path: locatorPath(r.root_path, r.rel_path),
        source: r.source,
        scene_id: r.scene_id,
        created_at: r.created_at
      }
    ])
  )
}

/** images 행이 없는 등록의 배지 — 생성 출력이면 생성 종류, 나머지(가져오기·재색인)는 가져온 이미지 */
export function registrationKind(reg: HistoryRegistrationRow): string {
  if (reg.source === 'generated' || reg.source === 'reclaim')
    return reg.scene_id != null ? 'scene' : 't2i'
  return 'external'
}

/**
 * 히스토리 한 페이지 — 원장 등록 ∪ images 행을 순번 내림차순으로 (db/history.ts historySeqs).
 * 지운(숨긴) 항목과 비우기 경계 아래는 빠진다 — 행·파일은 씬 갤러리를 위해 남아 있다.
 * 파일이 있는지는 이 페이지만 확인한다 (오프라인 루트의 항목은 빼지 않고 missing으로 표시)
 */
export function listImages(
  limit: number,
  offset: number,
  before?: number
): { items: HistoryItem[]; total: number } {
  const db = getDb()
  const { seqs, total } = db.transaction(() => ({
    seqs: historySeqs(db, { limit, offset, before }),
    total: historyCount(db)
  }))()
  const images = new Map(
    seqs.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT seq, file_path, length(thumbnail) AS thumb_size, kind, seed, created_at
               FROM images WHERE seq IN (${seqs.map(() => '?').join(',')})`
            )
            .all(...seqs) as HistoryImageRow[]
        ).map((r) => [r.seq, r])
  )
  const registrations = registrationsBySeq(seqs)

  const items: HistoryItem[] = []
  for (const seq of seqs) {
    const image = images.get(seq)
    const reg = registrations.get(seq)
    // 등록이 있으면 원장의 위치가 파일 경로다. 없으면(memory://, 루트 밖, 다른 기기 경로) 행의 경로
    const filePath = reg?.file_path ?? image?.file_path
    const createdAt = image?.created_at ?? reg?.created_at
    if (filePath === undefined || createdAt === undefined) continue
    const memory = isMemoryPath(filePath)
    items.push({
      id: seq,
      filePath,
      // 순번은 다시 쓰이지 않으니 URL이 다른 항목과 겹치지 않는다. 썸네일은 파일에서 (캐시) —
      // 저장된 썸네일이 없는 memory:// 행만 보여 줄 것이 없다
      thumbnailUrl:
        memory && !image?.thumb_size
          ? ''
          : thumbnailUrl('image', seq, createdAt, image?.thumb_size ?? 0),
      kind: image?.kind ?? (reg ? registrationKind(reg) : 't2i'),
      seed: image?.seed ?? null,
      createdAt,
      ...(!memory && !existsSync(filePath) ? { missing: true } : {})
    })
  }
  return { total, items }
}

/** 항목(순번)의 전송 payload — images 행이 없는 등록은 null */
export function getImagePayload(seq: number): string | null {
  const row = getDb().prepare('SELECT payload_json FROM images WHERE seq = ?').get(seq) as
    { payload_json: string } | undefined
  return row?.payload_json ?? null
}
