import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { getDb } from '../db'
import { allocateSeq } from '../db/history'
import {
  forgetIntent,
  isRegistered,
  locatorPath,
  mediaCollisions,
  pendingIntents,
  reclaimUnregistered,
  registerMedia
} from '../db/media'
import { readNaisMetadata } from './metadata'
import { syncMediaRoots } from './storage'
import { renderThumbnail } from './thumbnail-cache'

/**
 * 시작할 때 미디어 원장을 맞춘다 — DB가 열린 직후, 생성 큐보다 먼저.
 * 1) 저장 폴더를 루트로 2) 원장에 없는 행 되찾기(이 버전 전의 출력, 옛 앱이 쓴 출력)
 * 3) NFC 충돌 보고 4) 저장하다 멈춘 출력 되살리기(비동기 — 썸네일을 만든다).
 * 실패해도 앱은 뜬다: 다음 시작 때 다시 돈다
 */
export function prepareMedia(): void {
  try {
    const db = getDb()
    syncMediaRoots()
    const reclaimed = reclaimUnregistered(db)
    if (reclaimed.registered > 0) console.log(`media: reclaimed ${reclaimed.registered} outputs`)
    // 같은 파일을 가리키는 두 행 — 합치지 않는다. 먼저 등록된 쪽의 순번·숨김을 따른다
    for (const d of reclaimed.duplicates)
      console.warn(
        `media: image ${d.imageId} (seq ${d.seq}) points at ${d.filePath}, already registered as seq ${d.registeredSeq}`
      )
    const collisions = mediaCollisions(db)
    if (collisions.roots.length > 0 || collisions.files.length > 0)
      console.warn('media: paths that differ only in Unicode normalization', collisions)
  } catch (error) {
    console.error('media: preparing the media ledger failed', error)
  }
  void recoverPendingOutputs().catch((error) =>
    console.error('media: recovering pending outputs failed', error)
  )
}

export interface RecoveryResult {
  /** 파일만 남았던 출력을 등록했다 */
  recovered: number
  /** 이미 등록됐거나, 루트는 있는데 파일이 없다 (쓰기 전에 멈췄다) */
  dropped: number
  /** 루트가 보이지 않는다 (오프라인·언마운트) — 다음 시작 때 다시 본다 */
  kept: number
}

/**
 * 저장 의도가 남은 출력을 되살린다. 파일이 있으면 행과 등록을 새 순번으로 만든다 — 비우기 경계는
 * 건드리지 않는다(경계를 내리지도, 경계 아래 순번을 다시 쓰지도 않는다). 재현 설정은 파일의
 * NAIS 메타데이터에서 읽는다. 루트가 오프라인이면 의도를 지우지 않는다
 */
export async function recoverPendingOutputs(): Promise<RecoveryResult> {
  const db = getDb()
  const result: RecoveryResult = { recovered: 0, dropped: 0, kept: 0 }
  for (const intent of pendingIntents(db)) {
    if (isRegistered(db, intent)) {
      forgetIntent(db, intent.id)
      result.dropped++
      continue
    }
    const filePath = locatorPath(intent.rootPath, intent.relPath)
    let file: Buffer
    try {
      file = await readFile(filePath)
    } catch {
      if (existsSync(intent.rootPath)) {
        forgetIntent(db, intent.id)
        result.dropped++
      } else result.kept++
      continue
    }
    // 덜 쓰인 파일이면 디코드가 실패한다 — 그래도 사용자 폴더에 있는 파일이라 등록은 한다
    const thumbnail = await renderThumbnail(file).catch(() => null)
    const meta = readNaisMetadata(file)
    const payload = meta?.request
      ? JSON.stringify(
          meta.promptParts
            ? { ...meta.request, nais3: { promptParts: meta.promptParts } }
            : meta.request
        )
      : '{}'
    const recovered = db.transaction(() => {
      // 썸네일을 만드는 사이에 다른 곳에서 등록됐을 수 있다
      if (isRegistered(db, intent)) {
        forgetIntent(db, intent.id)
        return false
      }
      const seq = allocateSeq(db)
      db.prepare(
        `INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id, seq)
         VALUES (?, ?, ?, ?, ?, (SELECT id FROM gen_scenes WHERE id = ?), ?)`
      ).run(filePath, thumbnail, intent.kind, intent.seed, payload, intent.sceneId, seq)
      registerMedia(db, { ...intent, seq, source: 'generated' })
      forgetIntent(db, intent.id)
      return true
    })()
    if (recovered) result.recovered++
    else result.dropped++
  }
  return result
}
