import { mkdirSync } from 'fs'
import { basename, extname, join } from 'path'
import { getDb } from '../db'
import { syncExternalRoot } from '../db/media'
import sharp from '../sharp'
import { numberedName, safeFileStem } from './file-names'
import { naisRowFields } from './metadata'
import { commitOutput, defaultImagesRoot, syncMediaRoots, writeOutputExclusive } from './storage'
import { primeThumbnail, renderThumbnail } from './thumbnail-cache'

/**
 * 외부 이미지 — 히스토리 패널에 떨어뜨린 파일. 원본은 건드리지 않고 NAIS 폴더에 복사본을 만들어
 * 원장에 올리고, 히스토리에는 그 복사본을 보여 준다. 복사본 폴더는 external 루트(.nais 백업이
 * 복사본까지 담는다). 라이브러리(libraryRoot)와는 따로다
 */

/** 기본폴더/NAIS3_imported — 메인·씬 저장 폴더를 바꿔도 그대로 */
export function externalImportRoot(): string {
  return join(defaultImagesRoot(), 'NAIS3_imported')
}

// 파일 이름이 아니라 내용으로 고른다 — 히스토리가 그릴 수 있는 포맷만
const FORMAT_EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' }

export interface ExternalImportResult {
  imported: number
  /** 이미지가 아니거나 히스토리가 그릴 수 없는 포맷 */
  skipped: number
}

export async function importExternalImages(
  images: { name: string; base64: string }[]
): Promise<ExternalImportResult> {
  syncMediaRoots()
  syncExternalRoot(getDb(), externalImportRoot())
  const now = new Date()
  const dir = join(
    externalImportRoot(),
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  )
  const result: ExternalImportResult = { imported: 0, skipped: 0 }
  for (const image of images) {
    const bytes = Buffer.from(image.base64.replace(/^data:[^,]+,/, ''), 'base64')
    const format = await sharp(bytes)
      .metadata()
      .then((meta) => meta.format as string | undefined)
      .catch(() => undefined)
    const ext = format ? FORMAT_EXT[format] : undefined
    if (!ext) {
      result.skipped++
      continue
    }
    mkdirSync(dir, { recursive: true })
    const stem = safeFileStem(basename(image.name, extname(image.name)), 'image')
    const { payload, seed } = naisRowFields(bytes)
    const write = writeOutputExclusive({
      dir,
      name: (n) => numberedName(stem, n, ext, true),
      firstNumber: 1,
      bytes,
      kind: 'external',
      seed,
      sceneId: null
    })
    const thumbnail = await renderThumbnail(bytes).catch(() => null)
    commitOutput(write, {
      thumbnail,
      kind: 'external',
      seed,
      payload,
      sceneId: null,
      source: 'external'
    })
    if (thumbnail) await primeThumbnail(write.filePath, thumbnail)
    result.imported++
  }
  return result
}
