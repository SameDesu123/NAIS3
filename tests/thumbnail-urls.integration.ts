import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ db: null as Database.Database | null }))
vi.mock('electron', () => ({
  app: { getPath: () => '', getLocale: () => 'en' },
  BrowserWindow: {},
  dialog: {}
}))
vi.mock('../src/main/db', () => ({ getDb: () => mocks.db }))
vi.mock('../src/main/db/settings', () => ({ getSetting: () => null }))
import { migrations } from '../src/main/db/migrations'
import { listImages, thumbnailById } from '../src/main/images/storage'
import { listLibrary } from '../src/main/library/repo'
import { listScenes, sceneImages } from '../src/main/scenes/repo'

const thumbParams = (url: string): URLSearchParams => {
  expect(url.startsWith('nais-image://local/?')).toBe(true)
  return new URL(url).searchParams
}

beforeEach(() => {
  mocks.db = new Database(':memory:')
  for (const migrate of migrations) migrate(mocks.db)
})

afterEach(() => {
  mocks.db?.close()
  mocks.db = null
})

describe('thumbnail URLs instead of base64 in list IPC', () => {
  it('history and scene lists return URLs that resolve to the stored BLOB', () => {
    const db = mocks.db!
    db.exec(`
      INSERT INTO gen_scenes (id, name, preset_id) VALUES (1, 'scene', 1), (2, 'empty', 1);
      INSERT INTO images (id, file_path, thumbnail, payload_json, scene_id, favorite, created_at) VALUES
        (1, '/a.png', X'0A', '{}', 1, 1, '2026-01-01 00:00:00'),
        (2, '/b.png', X'0B', '{}', 1, 0, '2026-01-01 00:00:01'),
        (3, '/c.png', NULL, '{}', NULL, 0, '2026-01-01 00:00:02');
    `)

    const history = listImages(10, 0)
    expect(history.items.map((i) => i.id)).toEqual([3, 2, 1])
    expect(history.items[0].thumbnail).toBe('')
    const params = thumbParams(history.items[1].thumbnail)
    expect(params.get('thumb')).toBe('images')
    expect(thumbnailById(params.get('thumb')!, Number(params.get('id')))).toEqual(
      Buffer.from([0x0b])
    )

    // 씬 카드는 즐겨찾기 우선
    const [scene, empty] = listScenes(1)
    expect(thumbParams(scene.thumbnail).get('id')).toBe('1')
    expect(scene.thumbnailPath).toBe('/a.png')
    expect(scene.imageCount).toBe(2)
    expect(scene.hasFavorite).toBe(true)
    expect(empty.thumbnail).toBe('')
    expect(empty.thumbnailPath).toBe('')

    const detail = sceneImages(1, 10, 0)
    expect(detail.items.map((i) => thumbParams(i.thumbnail).get('id'))).toEqual(['2', '1'])
  })

  it('a reused row id gets a new URL so the old thumbnail is not shown from cache', () => {
    const db = mocks.db!
    db.prepare(
      "INSERT INTO images (id, file_path, thumbnail, payload_json, created_at) VALUES (1, '/a.png', X'01', '{}', '2026-01-01 00:00:00')"
    ).run()
    const before = listImages(1, 0).items[0].thumbnail
    db.exec('DELETE FROM images')
    db.prepare(
      "INSERT INTO images (file_path, thumbnail, payload_json, created_at) VALUES ('/b.png', X'02', '{}', '2026-01-01 00:00:05')"
    ).run()
    const after = listImages(1, 0).items[0]
    expect(after.id).toBe(1)
    expect(after.thumbnail).not.toBe(before)
  })

  it('library images and stack covers use URLs too', () => {
    const db = mocks.db!
    db.exec(`
      INSERT INTO library_stacks (id, name) VALUES (1, 'stack'), (2, 'empty');
      INSERT INTO library_images (id, name, file_path, thumbnail, stack_id, sort_order) VALUES
        (1, 'loose', '/l1.png', X'01', NULL, 1),
        (2, 'old', '/l2.png', X'02', 1, 2),
        (3, 'new', '/l3.png', X'03', 1, 3);
    `)
    const root = listLibrary(null, 10, 0)
    expect(root.items).toHaveLength(1)
    const loose = thumbParams(root.items[0].thumbnail)
    expect(thumbnailById(loose.get('thumb')!, Number(loose.get('id')))).toEqual(Buffer.from([0x01]))
    const stacks = Object.fromEntries(root.stacks.map((s) => [s.name, s]))
    expect(stacks.stack.count).toBe(2)
    expect(thumbParams(stacks.stack.coverThumbnail).get('id')).toBe('3')
    expect(stacks.empty.coverThumbnail).toBe('')
  })

  it('only serves thumbnails from whitelisted tables', () => {
    expect(thumbnailById('settings', 1)).toBeNull()
    expect(thumbnailById('images; DROP TABLE images', 1)).toBeNull()
    expect(thumbnailById('images', Number.NaN)).toBeNull()
  })
})
