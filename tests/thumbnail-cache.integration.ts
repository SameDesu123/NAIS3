import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// The app's sharp, not 'sharp' itself: importing sharp first loads the native build under
// Electron on Linux before src/main/sharp can switch to WebAssembly. This file hung in Linux CI that way.
import sharp from '../src/main/sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { allocateSeq } from '../src/main/db/history'
import { refreshSceneCover, sceneCover, sceneCoverForUrl } from '../src/main/images/covers'
import { listImages, saveGeneratedImage, thumbnailForUrl } from '../src/main/images/storage'
import { cacheRoot, clearMemoryCache } from '../src/main/images/thumbnail-cache'
import {
  deleteImage,
  getScene,
  listScenes,
  sceneImages,
  setImageFavorite
} from '../src/main/scenes/repo'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'en-US', getVersion: () => '0' },
  BrowserWindow: {},
  dialog: {},
  shell: { trashItem: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

type Rgb = [number, number, number]
const RED: Rgb = [220, 30, 30]
const GREEN: Rgb = [30, 200, 60]
const BLUE: Rgb = [30, 60, 220]
// 파일보다 한참 전에 만든 행 — 저장된 썸네일로 캐시를 채우지 않고 파일을 디코드하게
const OLD = '2020-01-01 00:00:00'

let root: string
let files: string

function png([r, g, b]: Rgb, width = 64, height = 48): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer()
}

/** webp는 손실 압축이라 색이 몇 단계 어긋난다 — 가장 가까운 테스트 색으로 돌려준다 */
async function colorOf(image: Buffer | null): Promise<Rgb> {
  expect(image).not.toBeNull()
  const { data } = await sharp(image!).raw().toBuffer({ resolveWithObject: true })
  const distance = (c: Rgb): number => c.reduce((sum, v, i) => sum + Math.abs(v - data[i]), 0)
  return [RED, GREEN, BLUE].reduce((best, c) => (distance(c) < distance(best) ? c : best))
}

/** 원본 파일을 쓰고 mtime을 정해 둔다 — 같은 초 안의 덮어쓰기도 버전이 갈리게 */
async function writeImage(name: string, color: Rgb, mtime: number, width = 64): Promise<string> {
  const path = join(files, name)
  writeFileSync(path, await png(color, width))
  utimesSync(path, mtime, mtime)
  return path
}

function insertImage(
  id: number,
  path: string,
  options: { scene?: number; favorite?: number; createdAt?: string; thumbnail?: Buffer } = {}
): void {
  getDb()
    .prepare(
      `INSERT INTO images (id, file_path, thumbnail, payload_json, scene_id, favorite, created_at, seq)
       VALUES (?, ?, ?, '{}', ?, ?, ?, ?)`
    )
    .run(
      id,
      path,
      options.thumbnail ?? Buffer.from([1]),
      options.scene ?? null,
      options.favorite ?? 0,
      options.createdAt ?? OLD,
      allocateSeq(getDb())
    )
}

const thumb = (id: number): Promise<Buffer | null> =>
  thumbnailForUrl(new URL(`nais-image://local/?thumb=image&id=${id}`))

const coverSource = (sceneId: number): { imageId: number; mtimeMs: number } =>
  JSON.parse(readFileSync(join(cacheRoot(), 'covers', `${sceneId}.json`), 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-thumbnail-cache-'))
  files = join(root, 'files')
  mkdirSync(files)
  environment.directory = root
  clearMemoryCache()
  initDb()
  getDb().exec(`INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES (1, 1, 'a', 0)`)
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('output thumbnails', () => {
  it('builds them from the file into userData/nais-cache, not from the stored thumbnail', async () => {
    insertImage(1, await writeImage('a.png', RED, 1_800_000_000, 1280))
    const first = await thumb(1)
    expect(await colorOf(first)).toEqual(RED)
    expect(await sharp(first!).metadata()).toMatchObject({ format: 'webp', width: 640 })
    expect(existsSync(join(root, 'nais-cache', 'thumbs'))).toBe(true)
    // Chromium's own userData/Cache is left alone
    expect(existsSync(join(root, 'Cache'))).toBe(false)
  })

  it('rebuilds a thumbnail when the file changes outside the app', async () => {
    const path = await writeImage('a.png', RED, 1_800_000_000)
    insertImage(1, path)
    expect(await colorOf(await thumb(1))).toEqual(RED)
    // Same size, new mtime
    await writeImage('a.png', BLUE, 1_800_000_010)
    expect(await colorOf(await thumb(1))).toEqual(BLUE)
    // Same mtime, new size
    await writeImage('a.png', GREEN, 1_800_000_010, 80)
    expect(await colorOf(await thumb(1))).toEqual(GREEN)
  })

  it('seeds the cache from the stored thumbnail of a file that has not changed since it was saved', async () => {
    const saved = await saveGeneratedImage({
      png: await png(RED),
      sentPayload: '{}',
      seed: 1,
      kind: 't2i'
    })
    const stored = getDb().prepare('SELECT thumbnail FROM images WHERE id = ?').get(saved.id) as {
      thumbnail: Buffer
    }
    rmSync(cacheRoot(), { recursive: true, force: true })
    clearMemoryCache()
    expect((await thumb(saved.id))!.equals(stored.thumbnail)).toBe(true)
  })

  it('falls back to the stored thumbnail for a missing file or a memory image', async () => {
    insertImage(1, join(files, 'gone.png'), { thumbnail: Buffer.from([7]) })
    insertImage(2, 'memory://x.png', { thumbnail: Buffer.from([8]) })
    expect(await thumb(1)).toEqual(Buffer.from([7]))
    expect(await thumb(2)).toEqual(Buffer.from([8]))
    expect(await thumb(3)).toBeNull()
  })

  it('falls back for files sharp cannot decode and frees every decode slot', async () => {
    for (let id = 1; id <= 5; id++) {
      const path = join(files, `broken-${id}.png`)
      writeFileSync(path, `not an image ${id}`)
      insertImage(id, path, { thumbnail: Buffer.from([id]) })
    }
    insertImage(6, await writeImage('ok.png', RED, 1_800_000_000))
    const all = await Promise.all([1, 2, 3, 4, 5, 6].map(thumb))
    expect(all.slice(0, 5)).toEqual([1, 2, 3, 4, 5].map((id) => Buffer.from([id])))
    expect(await colorOf(all[5])).toEqual(RED)
    // Nothing is left holding a slot: more decodes still go through
    insertImage(7, await writeImage('ok2.png', GREEN, 1_800_000_000))
    insertImage(8, await writeImage('ok3.png', BLUE, 1_800_000_000))
    expect(await Promise.all([thumb(7), thumb(8)].map(async (t) => colorOf(await t)))).toEqual([
      GREEN,
      BLUE
    ])
  })

  it('keeps writing the stored thumbnail for 1.0.29', async () => {
    const saved = await saveGeneratedImage({
      png: await png(RED),
      sentPayload: '{}',
      seed: 1,
      kind: 't2i'
    })
    const { items } = listImages(10, 0)
    expect(items[0]).toMatchObject({
      id: saved.id,
      thumbnailUrl: expect.stringContaining('thumb=')
    })
  })
})

describe('scene covers', () => {
  const coverColor = async (): Promise<Rgb> => colorOf(await sceneCover(1))

  it('serves the newest image, then the favorite, and moves with generation', async () => {
    insertImage(1, await writeImage('1.png', RED, 1_800_000_000), { scene: 1 })
    insertImage(2, await writeImage('2.png', GREEN, 1_800_000_000), { scene: 1 })
    const url = listScenes(1)[0].thumbnailUrl
    expect(url).toMatch(/^nais-image:\/\/local\/\?cover=1&v=/)
    expect(await colorOf(await sceneCoverForUrl(new URL(url)))).toEqual(GREEN)
    expect(existsSync(join(cacheRoot(), 'covers', '1.webp'))).toBe(true)
    expect(coverSource(1).imageId).toBe(2)

    // Favorite change: refreshed right away, and the card URL changes
    await refreshSceneCover(setImageFavorite(1, true))
    expect(coverSource(1).imageId).toBe(1)
    expect(listScenes(1)[0].thumbnailUrl).not.toBe(url)
    expect(await coverColor()).toEqual(RED)
    await refreshSceneCover(setImageFavorite(1, false))
    expect(await coverColor()).toEqual(GREEN)

    // Generation
    const saved = await saveGeneratedImage({
      png: await png(BLUE),
      sentPayload: '{}',
      seed: 1,
      kind: 'scene',
      sceneId: 1,
      sceneName: 'a'
    })
    await refreshSceneCover(1)
    expect(coverSource(1).imageId).toBe(saved.id)
    expect(await coverColor()).toEqual(BLUE)
  })

  it('rebuilds when the cover file changes outside the app or the cover image is hidden', async () => {
    insertImage(1, await writeImage('1.png', RED, 1_800_000_000), { scene: 1 })
    insertImage(2, await writeImage('2.png', GREEN, 1_800_000_000), { scene: 1 })
    expect(await coverColor()).toEqual(GREEN)
    await writeImage('2.png', BLUE, 1_800_000_020)
    expect(await coverColor()).toEqual(BLUE)
    expect(coverSource(1).mtimeMs).toBe(1_800_000_020_000)
    await deleteImage(2, 'scene')
    expect(await coverColor()).toEqual(RED)
  })

  it('stops serving the old cover when its file is gone', async () => {
    insertImage(1, await writeImage('1.png', RED, 1_800_000_000), {
      scene: 1,
      thumbnail: Buffer.from([9])
    })
    expect(await coverColor()).toEqual(RED)
    rmSync(join(files, '1.png'))
    expect(await sceneCover(1)).toEqual(Buffer.from([9]))
  })

  it('has no cover for a scene without images or a bad id', async () => {
    expect(await sceneCover(1)).toBeNull()
    expect(listScenes(1)[0].thumbnailUrl).toBe('')
    expect(await sceneCoverForUrl(new URL('nais-image://local/?cover=x'))).toBeNull()
  })
})

it('loses nothing that matters when the whole cache is deleted', async () => {
  getDb().exec(`INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES (2, 1, 'b', 1)`)
  insertImage(1, await writeImage('1.png', RED, 1_800_000_000), { scene: 1, favorite: 1 })
  insertImage(2, await writeImage('2.png', GREEN, 1_800_000_000), { scene: 1 })
  insertImage(3, await writeImage('3.png', BLUE, 1_800_000_000), { scene: 2 })
  insertImage(4, await writeImage('4.png', GREEN, 1_800_000_000))
  await deleteImage(4, 'history')
  await deleteImage(3, 'scene')
  for (const id of [1, 2, 3, 4]) await thumb(id)
  await refreshSceneCover(1)

  const state = (): unknown => ({
    history: listImages(10, 0),
    scenes: listScenes(1),
    scene1: sceneImages(1, 10, 0),
    scene2: sceneImages(2, 10, 0),
    hidden: getDb().prepare('SELECT * FROM images ORDER BY id').all(),
    scene: getScene(1)
  })
  const before = state()

  rmSync(cacheRoot(), { recursive: true, force: true })
  clearMemoryCache()

  expect(state()).toEqual(before)
  expect(await colorOf(await sceneCover(1))).toEqual(RED)
  expect(await sceneCover(2)).toBeNull()
  expect(await colorOf(await thumb(2))).toEqual(GREEN)
  expect(existsSync(join(cacheRoot(), 'covers', '1.webp'))).toBe(true)
  expect(existsSync(join(cacheRoot(), 'thumbs'))).toBe(true)
  expect(readFileSync(join(files, '4.png')).length).toBeGreaterThan(0)
})
