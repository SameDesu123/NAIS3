import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
// The app's sharp, not 'sharp' itself (see thumbnail-cache.integration.ts)
import sharp from '../src/main/sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { allocateSeq, hideSeqs } from '../src/main/db/history'
import { registerMedia, type RegistrationSource } from '../src/main/db/media'
import { sceneCover } from '../src/main/images/covers'
import { sceneCountSql, sceneCoverSeqSql } from '../src/main/scenes/items'
import { listImages, scenesRoot, syncMediaRoots } from '../src/main/images/storage'
import {
  bulkClearImages,
  bulkExportZip,
  deleteNonFavorites,
  getScene,
  listScenes,
  sceneImages,
  setImageFavorite
} from '../src/main/scenes/repo'

const environment = vi.hoisted(() => ({ directory: '', zipPath: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'en-US', getVersion: () => '0' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: environment.zipPath })
  },
  shell: { trashItem: vi.fn(async () => undefined) },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let root: string
let sceneRootId: number

const RED = { r: 220, g: 30, b: 30 }
const GREEN = { r: 30, g: 200, b: 60 }

async function writePng(path: string, color = RED): Promise<string> {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    await sharp({ create: { width: 16, height: 16, channels: 3, background: color } })
      .png()
      .toBuffer()
  )
  return path
}

function insertRoot(path: string, status: 'current' | 'past' | 'unmapped'): number {
  return getDb()
    .prepare(
      `INSERT INTO media_roots (kind, path, path_key, status) VALUES ('scene', ?, ?, ?) RETURNING id`
    )
    .pluck()
    .get(path, path, status) as number
}

/** 원장에만 있는 씬 항목 (재색인·복원) */
function register(
  rootId: number,
  relPath: string,
  sceneId: number | null,
  source: RegistrationSource = 'reindex'
): number {
  const db = getDb()
  return registerMedia(db, { rootId, relPath, seq: allocateSeq(db), source, sceneId }).seq
}

/** 생성 출력처럼 images 행 + 같은 순번의 등록 */
function insertOutput(
  relPath: string,
  sceneId: number,
  options: { favorite?: boolean } = {}
): number {
  const db = getDb()
  const seq = allocateSeq(db)
  db.prepare(
    `INSERT INTO images (file_path, thumbnail, kind, payload_json, scene_id, favorite, seq)
     VALUES (?, NULL, 'scene', '{}', ?, ?, ?)`
  ).run(join(scenesRoot(), ...relPath.split('/')), sceneId, options.favorite ? 1 : 0, seq)
  registerMedia(db, { rootId: sceneRootId, relPath, seq, source: 'generated', sceneId })
  return seq
}

const galleryIds = (sceneId: number, favoritesOnly = false): number[] =>
  sceneImages(sceneId, 100, 0, favoritesOnly).items.map((i) => i.id)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-scene-ledger-'))
  environment.directory = root
  environment.zipPath = join(root, 'out.zip')
  initDb()
  getDb().exec(`INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES
    (1, 1, 'alpha', 0), (2, 1, 'beta', 1)`)
  sceneRootId = syncMediaRoots().scene
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('scene reads from the ledger', () => {
  it('counts and shows ledger-only items, across roots, newest first', async () => {
    const generated = insertOutput('p/alpha/alpha_1.png', 1)
    await writePng(join(scenesRoot(), 'p', 'alpha', 'alpha_1.png'))
    // 예전 씬 루트(past)에 남은 재색인 항목
    const oldRoot = join(root, 'old-scenes')
    const past = insertRoot(oldRoot, 'past')
    await writePng(join(oldRoot, 'alpha', 'old.png'))
    const old = register(past, 'alpha/old.png', 1)
    const uuid = register(sceneRootId, 'u-1/alpha_2.png', 1)
    await writePng(join(scenesRoot(), 'u-1', 'alpha_2.png'), GREEN)

    expect(galleryIds(1)).toEqual([uuid, old, generated])
    expect(sceneImages(1, 100, 0).items.map((i) => i.filePath)).toEqual([
      join(scenesRoot(), 'u-1', 'alpha_2.png'),
      join(oldRoot, 'alpha', 'old.png'),
      join(scenesRoot(), 'p', 'alpha', 'alpha_1.png')
    ])
    expect(sceneImages(1, 1, 1)).toMatchObject({ total: 3, items: [{ id: old }] })
    expect(getScene(1)?.imageCount).toBe(3)
    const [alpha, beta] = listScenes(1)
    expect(alpha).toMatchObject({
      imageCount: 3,
      hasFavorite: false,
      thumbnailPath: join(scenesRoot(), 'u-1', 'alpha_2.png')
    })
    expect(beta).toMatchObject({ imageCount: 0, thumbnailUrl: '', thumbnailPath: '' })
    // 원장에만 있는 표지도 파일에서 만든다
    const { data } = await sharp(await sceneCover(1))
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(data[1]).toBeGreaterThan(150)
  })

  it('attributes a shared legacy folder per registration, and lets an images row decide', () => {
    // 두 씬이 같은 이름 폴더를 썼다 — 파일마다 갈린다
    const a = register(sceneRootId, 'p/shared/a.png', 1)
    const b = register(sceneRootId, 'p/shared/b.png', 2)
    const loose = register(sceneRootId, 'p/shared/c.png', null)
    expect(galleryIds(1)).toEqual([a])
    expect(galleryIds(2)).toEqual([b])
    expect(listScenes(1).map((s) => s.imageCount)).toEqual([1, 1])

    // 행이 있으면 행의 scene_id가 귀속을 정한다
    const seq = insertOutput('p/shared/d.png', 1)
    getDb().prepare('UPDATE media_registrations SET scene_id = 2 WHERE seq = ?').run(seq)
    expect(galleryIds(1)).toEqual([seq, a])
    expect(galleryIds(2)).toEqual([b])
    expect(galleryIds(1).concat(galleryIds(2))).not.toContain(loose)
  })

  it('applies scene hides only, leaves unmapped roots out, and marks offline files missing', async () => {
    const hidden = register(sceneRootId, 'u-1/hidden.png', 1)
    const historyHidden = register(sceneRootId, 'u-1/history-hidden.png', 1)
    hideSeqs(getDb(), [hidden], 'scene')
    hideSeqs(getDb(), [historyHidden], 'history')
    register(insertRoot(join(root, 'other-device'), 'unmapped'), 'alpha/x.png', 1)
    const offline = register(insertRoot(join(root, 'unplugged'), 'past'), 'alpha/y.png', 1)
    const present = register(sceneRootId, 'u-1/present.png', 1)
    await writePng(join(scenesRoot(), 'u-1', 'present.png'))
    await writePng(join(scenesRoot(), 'u-1', 'history-hidden.png'))

    const { items, total } = sceneImages(1, 100, 0)
    expect(total).toBe(3)
    expect(items.map((i) => [i.id, i.missing ?? false])).toEqual([
      [present, false],
      [offline, true],
      [historyHidden, false]
    ])
    expect(listScenes(1)[0].imageCount).toBe(3)
  })

  it('favorites a ledger-only item by adding its images row with the same seq', async () => {
    const older = insertOutput('u-1/a.png', 1)
    const found = register(sceneRootId, 'u-1/found.png', 1)
    const historyBefore = listImages(10, 0).items.find((i) => i.id === found)

    expect(setImageFavorite(found, true)).toBe(1)
    const row = getDb()
      .prepare('SELECT file_path, kind, favorite, scene_id FROM images WHERE seq = ?')
      .get(found)
    expect(row).toEqual({
      file_path: join(scenesRoot(), 'u-1', 'found.png'),
      // 원장 항목과 같은 배지 — 재색인한 파일은 가져온 이미지
      kind: 'external',
      favorite: 1,
      scene_id: 1
    })
    expect(galleryIds(1, true)).toEqual([found])
    expect(listScenes(1)[0]).toMatchObject({ hasFavorite: true, imageCount: 2 })
    // 히스토리에서는 같은 항목 그대로 (한 번만)
    const history = listImages(10, 0).items.filter((i) => i.id === found)
    expect(history).toEqual([historyBefore])

    // 즐겨찾기 해제는 행만 바꾼다. 원장에 없는 순번은 아무것도 만들지 않는다
    expect(setImageFavorite(found, false)).toBe(1)
    expect(listScenes(1)[0].hasFavorite).toBe(false)
    expect(setImageFavorite(older + 1000, true)).toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(2)
  })

  it('removes ledger-only items from the scene gallery in bulk, keeping favorites', async () => {
    const favorite = insertOutput('u-1/fav.png', 1, { favorite: true })
    const plain = insertOutput('u-1/plain.png', 1)
    const found = register(sceneRootId, 'u-1/found.png', 1)
    const other = register(sceneRootId, 'u-2/other.png', 2)

    const result = await deleteNonFavorites(1)
    expect(result.results.map((r) => r.id).sort()).toEqual([plain, found].sort())
    expect(galleryIds(1)).toEqual([favorite])
    // 씬 scope만 — 히스토리엔 남는다
    expect(listImages(10, 0).total).toBe(4)

    await bulkClearImages([1, 2])
    expect(galleryIds(1)).toEqual([])
    expect(galleryIds(2)).toEqual([])
    expect(listScenes(1).map((s) => s.imageCount)).toEqual([0, 0])
    expect(listImages(10, 0).items.map((i) => i.id)).toContain(other)
  })

  it('zips the favorites or newest file that exists, and counts what it wrote', async () => {
    // alpha: 즐겨찾기 둘 중 하나는 오프라인
    insertOutput('u-1/fav-gone.png', 1, { favorite: true })
    insertOutput('u-1/fav-here.png', 1, { favorite: true })
    await writePng(join(scenesRoot(), 'u-1', 'fav-here.png'))
    // beta: 즐겨찾기 없음, 최신 항목은 오프라인이라 그 앞의 파일
    register(sceneRootId, 'u-2/older.png', 2)
    await writePng(join(scenesRoot(), 'u-2', 'older.png'), GREEN)
    register(insertRoot(join(root, 'unplugged'), 'past'), 'beta/newest.png', 2)

    expect(await bulkExportZip([1, 2])).toBe(2)
    const zip = await JSZip.loadAsync(readFileSync(environment.zipPath))
    expect(Object.keys(zip.files).sort()).toEqual(['alpha.png', 'beta.png'])
  })

  it('never loads stored thumbnails for galleries, bulk removal or ZIP, only for a cover', async () => {
    const db = getDb()
    for (const name of ['a', 'b', 'c']) insertOutput(`u-1/${name}.png`, 1)
    db.prepare('UPDATE images SET thumbnail = ?').run(Buffer.from('stored'))
    await writePng(join(scenesRoot(), 'u-1', 'a.png'))
    const statements: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      statements.push(sql)
      return prepare(sql)
    }) as typeof db.prepare)
    const readsThumbnail = (): boolean =>
      statements.some((sql) => /\bthumbnail\b/.test(sql) && /^\s*SELECT/i.test(sql))
    try {
      sceneImages(1, 100, 0)
      listScenes(1)
      expect(await bulkExportZip([1])).toBe(1)
      await deleteNonFavorites(1)
      expect(readsThumbnail()).toBe(false)

      // 원본이 없는 표지는 저장된 썸네일을 읽는다
      db.prepare('DELETE FROM media_hidden').run()
      expect(await sceneCover(1)).toEqual(Buffer.from('stored'))
      expect(readsThumbnail()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('reads scene cards through the scene indexes, never a full scan', () => {
    const plan = (
      getDb()
        .prepare(
          `EXPLAIN QUERY PLAN SELECT s.id, ${sceneCountSql('s.id')}, ${sceneCoverSeqSql('s.id')}
           FROM gen_scenes s WHERE s.preset_id = ?`
        )
        .all(1) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join('\n')
    expect(plan).toContain('idx_media_registrations_scene')
    expect(plan).toContain('idx_images_scene_favorite')
    expect(plan).not.toMatch(/\bSCAN (images|r|media_registrations)\b/)
  })
})
