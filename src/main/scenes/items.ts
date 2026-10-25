import { existsSync } from 'fs'
import { getDb } from '../db'
import { ensureSeqs, sceneVisible } from '../db/history'
import { isMemoryPath, registrationsBySeq } from '../images/storage'

/**
 * 씬 항목 = 그 씬의 images 행 ∪ images 행이 없는 원장 등록(재색인·복원), 순번(seq)이 정체성이다.
 * 행이 있으면 행의 scene_id가 귀속을 정한다 — images.favorite처럼 행이 기준이다(H까지). 원장에만
 * 있는 항목은 등록마다의 scene_id로 귀속한다: 여러 씬이 함께 쓴 옛 이름 폴더도 파일마다 갈리고,
 * 이전 씬 루트(past)의 등록도 그대로 씬에 남는다. 다른 기기에서 복원해 온(unmapped) 루트의 등록은
 * 읽을 수 없어 빠진다. 씬 scope 숨김은 두 쪽 모두에서 빠진다
 */
function ledgerOnly(scene: string): string {
  return `FROM media_registrations r JOIN media_roots ro ON ro.id = r.root_id
    WHERE r.scene_id = ${scene} AND ro.status != 'unmapped' AND ${sceneVisible('r')}
      AND NOT EXISTS (SELECT 1 FROM images WHERE images.seq = r.seq)`
}

function sceneRows(scene: string): string {
  return `FROM images WHERE images.scene_id = ${scene} AND ${sceneVisible()}`
}

/** 씬 항목 수 (scene: SQL 식 — '?', '@scene', 's.id'). 두 쪽이 겹치지 않아 그냥 더한다 */
export function sceneCountSql(scene: string): string {
  return `((SELECT COUNT(*) ${sceneRows(scene)}) + (SELECT COUNT(*) ${ledgerOnly(scene)}))`
}

/**
 * 씬 표지의 순번 — 즐겨찾기가 있으면 최신 즐겨찾기, 없으면 최신 항목 (NAIS2 방식).
 * 즐겨찾기는 images 행에만 있다
 */
export function sceneCoverSeqSql(scene: string): string {
  return `COALESCE(
    (SELECT images.seq ${sceneRows(scene)} AND images.favorite = 1 ORDER BY images.seq DESC LIMIT 1),
    (SELECT MAX(seq) FROM (
      SELECT images.seq AS seq ${sceneRows(scene)}
      UNION ALL SELECT r.seq ${ledgerOnly(scene)}
    ))
  )`
}

/** 씬 갤러리 한 페이지의 순번 (최신부터). 즐겨찾기만이면 images 행만 */
export function scenePage(
  sceneId: number,
  page: { limit: number; offset: number; favoritesOnly?: boolean }
): { seqs: number[]; total: number } {
  const db = getDb()
  ensureSeqs(db)
  if (page.favoritesOnly) {
    const rows = `${sceneRows('@scene')} AND images.favorite = 1`
    return {
      total: db.prepare(`SELECT COUNT(*) ${rows}`).pluck().get({ scene: sceneId }) as number,
      seqs: db
        .prepare(`SELECT images.seq ${rows} ORDER BY images.seq DESC LIMIT @limit OFFSET @offset`)
        .pluck()
        .all({ scene: sceneId, limit: page.limit, offset: page.offset }) as number[]
    }
  }
  return {
    total: db
      .prepare(`SELECT ${sceneCountSql('@scene')}`)
      .pluck()
      .get({ scene: sceneId }) as number,
    seqs: db
      .prepare(
        `SELECT images.seq AS seq ${sceneRows('@scene')}
         UNION ALL SELECT r.seq ${ledgerOnly('@scene')}
         ORDER BY seq DESC LIMIT @limit OFFSET @offset`
      )
      .pluck()
      .all({ scene: sceneId, limit: page.limit, offset: page.offset }) as number[]
  }
}

/** 씬 항목 전부의 순번 (최신부터) — 일괄 지우기·ZIP. nonFavorites면 즐겨찾기를 뺀다 */
export function sceneSeqs(sceneId: number, options: { nonFavorites?: boolean } = {}): number[] {
  const db = getDb()
  ensureSeqs(db)
  const favorite = options.nonFavorites ? ' AND images.favorite = 0' : ''
  return db
    .prepare(
      `SELECT images.seq AS seq ${sceneRows('@scene')}${favorite}
       UNION ALL SELECT r.seq ${ledgerOnly('@scene')}
       ORDER BY seq DESC`
    )
    .pluck()
    .all({ scene: sceneId }) as number[]
}

/** 씬 즐겨찾기의 순번 (최신부터) */
export function sceneFavoriteSeqs(sceneId: number): number[] {
  ensureSeqs(getDb())
  return getDb()
    .prepare(
      `SELECT images.seq ${sceneRows('@scene')} AND images.favorite = 1 ORDER BY images.seq DESC`
    )
    .pluck()
    .all({ scene: sceneId }) as number[]
}

export interface SceneEntry {
  seq: number
  /** images 행이 없는 원장 항목이면 null */
  imageId: number | null
  /** 원장의 위치가 먼저, 없으면(memory://, 루트 밖) 행의 경로 — 히스토리와 같다 */
  filePath: string
  createdAt: string
  seed: number | null
  favorite: boolean
  thumbnail: Buffer | null
}

/** 순번들의 항목 내용 (순서는 seqs 그대로, 찾지 못한 순번은 빠진다) */
export function sceneEntries(seqs: number[]): SceneEntry[] {
  // 바인딩 변수 한도를 넘지 않게 나눠 읽는다 (큰 씬의 일괄 지우기)
  const entries: SceneEntry[] = []
  for (let i = 0; i < seqs.length; i += 500) entries.push(...entryChunk(seqs.slice(i, i + 500)))
  return entries
}

function entryChunk(seqs: number[]): SceneEntry[] {
  const rows = new Map(
    (
      getDb()
        .prepare(
          `SELECT id, seq, file_path, created_at, seed, favorite, thumbnail FROM images
           WHERE seq IN (${seqs.map(() => '?').join(',')})`
        )
        .all(...seqs) as {
        id: number
        seq: number
        file_path: string
        created_at: string
        seed: number | null
        favorite: number
        thumbnail: Buffer | null
      }[]
    ).map((r) => [r.seq, r])
  )
  const registrations = registrationsBySeq(seqs)
  const entries: SceneEntry[] = []
  for (const seq of seqs) {
    const row = rows.get(seq)
    const reg = registrations.get(seq)
    const filePath = reg?.file_path ?? row?.file_path
    const createdAt = row?.created_at ?? reg?.created_at
    if (filePath === undefined || createdAt === undefined) continue
    entries.push({
      seq,
      imageId: row?.id ?? null,
      filePath,
      createdAt,
      seed: row?.seed ?? null,
      favorite: row?.favorite === 1,
      thumbnail: row?.thumbnail ?? null
    })
  }
  return entries
}

/** 파일이 지금 없는지 (오프라인 루트, 옮긴 파일). memory:// 는 파일이 아니다 */
export function isMissing(filePath: string): boolean {
  return !isMemoryPath(filePath) && !existsSync(filePath)
}
