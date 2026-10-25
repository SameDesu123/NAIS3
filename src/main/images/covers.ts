import { stat } from 'fs/promises'
import { join } from 'path'
import { getDb } from '../db'
import { sceneCoverSeqSql, sceneEntries } from '../scenes/items'
import { isMemoryPath, rowThumbnail, type ThumbnailRow } from './storage'
import {
  cacheRoot,
  memoryGet,
  memorySet,
  readCacheFile,
  sameVersion,
  sourceVersion,
  writeCacheFile,
  type SourceVersion
} from './thumbnail-cache'

/**
 * 씬 카드 표지 캐시 — nais-cache/covers/<씬 id>.webp, 옆의 .json에 어느 파일의 어느 버전에서
 * 만들었는지 적는다. 요청마다 지금의 표지 항목(즐겨찾기 우선, 최신)·원본 파일과 맞춰 보고
 * 다르면 다시 만든다 — 생성·즐겨찾기 변경·숨김·파일이 밖에서 바뀐 경우 모두 여기서 잡힌다.
 * 언제 지워도 다음 요청 때 다시 만든다.
 */

interface CoverSource extends SourceVersion {
  /** 표지 항목의 순번 */
  seq: number
}

function coverFile(sceneId: number): string {
  return join(cacheRoot(), 'covers', `${sceneId}.webp`)
}

function sourceFile(sceneId: number): string {
  return join(cacheRoot(), 'covers', `${sceneId}.json`)
}

async function readSource(sceneId: number): Promise<CoverSource | null> {
  try {
    return JSON.parse((await readCacheFile(sourceFile(sceneId)))?.toString('utf8') ?? 'null')
  } catch {
    return null
  }
}

/** 씬 카드 표지. 표지로 쓸 이미지가 없으면 null — 원본이 없으면 저장된 썸네일로 */
export async function sceneCover(sceneId: number): Promise<Buffer | null> {
  // 카드 썸네일: 즐겨찾기가 있으면 최신 즐겨찾기, 없으면 최신 항목 — listScenes와 같은 선택.
  // 원장에만 있는 항목(재색인·복원)도 표지가 된다 — 저장된 썸네일이 없을 뿐
  const seq = getDb()
    .prepare(`SELECT ${sceneCoverSeqSql('@scene')}`)
    .pluck()
    .get({ scene: sceneId }) as number | null
  const entry = seq != null ? sceneEntries([seq])[0] : undefined
  if (!entry) return null
  const row: ThumbnailRow = {
    file_path: entry.filePath,
    created_at: entry.createdAt,
    thumbnail: entry.thumbnail
  }
  if (isMemoryPath(row.file_path)) return row.thumbnail
  let current: CoverSource
  try {
    current = { seq: entry.seq, ...sourceVersion(row.file_path, await stat(row.file_path)) }
  } catch {
    // 원본이 사라졌다 — 옛 표지 대신 저장된 썸네일 (없으면 카드가 원본 경로로 폴백)
    return row.thumbnail
  }

  const memoryKey = `cover\0${sceneId}\0${JSON.stringify(current)}`
  const hit = memoryGet(memoryKey)
  if (hit) return hit
  const saved = await readSource(sceneId)
  let cover =
    saved?.seq === current.seq && sameVersion(saved, current)
      ? await readCacheFile(coverFile(sceneId))
      : null
  if (!cover) {
    cover = await rowThumbnail(row)
    if (!cover) return null
    // 표지 먼저, 출처는 나중에 — 그 사이에 멈추면 출처가 안 맞아 다음 요청 때 다시 만든다
    await writeCacheFile(coverFile(sceneId), cover)
    await writeCacheFile(sourceFile(sceneId), JSON.stringify(current))
  }
  memorySet(memoryKey, cover)
  return cover
}

/** 표지를 미리 다시 만든다 (생성·즐겨찾기 변경 뒤). 실패해도 다음 요청 때 다시 만든다 */
export async function refreshSceneCover(sceneId: number | null | undefined): Promise<void> {
  if (sceneId == null) return
  await sceneCover(sceneId).catch(() => null)
}

/** `coverUrl()` 요청 → 표지 바이트 (잘못된 id나 표지가 없으면 null) */
export function sceneCoverForUrl(url: URL): Promise<Buffer | null> {
  const sceneId = Number(url.searchParams.get('cover'))
  return Number.isInteger(sceneId) ? sceneCover(sceneId) : Promise.resolve(null)
}
