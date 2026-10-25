import { opendir } from 'fs/promises'
import { join } from 'path'
import type { MediaReindexResult } from '../../shared/types'
import { getDb } from '../db'
import { pathKey, readableRoots, reclaimUnregistered, registerFoundFiles } from '../db/media'
import { syncMediaRoots } from './storage'

/**
 * 미디어 재인덱싱 — 사용자가 설정에서 누른다. 등록된 루트(지금·이전 저장 폴더, 외부 복사본)를 훑어
 * 원장에 없는 이미지를 올린다. NAIS가 만들지 않은 이미지도. 위치로 중복을 거르고(이미 등록된 파일은
 * 순번·숨김 그대로), 숨김을 풀지 않는다. 지우지 않는다.
 * 순회는 트랜잭션 밖에서, 등록은 짧은 배치 트랜잭션으로 — 그사이에 생성·저장이 끼어들 수 있다.
 * 보이지 않는 루트(오프라인·언마운트)는 건너뛴다. 점으로 시작하는 이름과 심볼릭 링크는 따라가지 않는다
 */

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i
const BATCH = 200

function dirKey(path: string): string {
  const key = pathKey(path)
  return process.platform === 'win32' ? key.toLowerCase() : key
}

async function* imageFiles(dir: string, otherRoots: Set<string>): AsyncGenerator<string> {
  let handle: Awaited<ReturnType<typeof opendir>>
  try {
    handle = await opendir(dir)
  } catch {
    return // 없거나 읽을 수 없는 폴더
  }
  for await (const entry of handle) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    // opendir의 Dirent는 링크를 따라가지 않는다 — 심볼릭 링크는 파일도 폴더도 아니다
    if (entry.isDirectory()) {
      // 안쪽에 있는 다른 루트는 그 루트 차례에 훑는다
      if (!otherRoots.has(dirKey(path))) yield* imageFiles(path, otherRoots)
    } else if (entry.isFile() && IMAGE_FILE.test(entry.name)) yield path
  }
}

let running: Promise<MediaReindexResult> | null = null

/** 이미 돌고 있으면 그 결과를 기다린다 */
export function reindexMedia(
  onProgress?: (progress: MediaReindexResult) => void
): Promise<MediaReindexResult> {
  running ??= scan(onProgress).finally(() => {
    running = null
  })
  return running
}

async function scan(
  onProgress?: (progress: MediaReindexResult) => void
): Promise<MediaReindexResult> {
  const db = getDb()
  syncMediaRoots()
  // images 행이 있는 파일은 그 행의 순번으로 — 숨김·비우기 경계가 따라온다
  reclaimUnregistered(db)
  const roots = readableRoots(db)
  const result: MediaReindexResult = { scanned: 0, registered: 0 }
  let batch: string[] = []
  const flush = (): void => {
    result.registered += registerFoundFiles(db, batch)
    batch = []
    onProgress?.({ ...result })
  }
  for (const root of roots) {
    const otherRoots = new Set(roots.filter((r) => r.id !== root.id).map((r) => dirKey(r.path)))
    for await (const file of imageFiles(root.path, otherRoots)) {
      result.scanned++
      batch.push(file)
      if (batch.length >= BATCH) flush()
    }
  }
  flush()
  return result
}
