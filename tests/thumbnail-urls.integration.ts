import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { sceneCoverForUrl } from '../src/main/images/covers'
import { listImages, thumbnailForUrl } from '../src/main/images/storage'
import { listLibrary } from '../src/main/library/repo'
import { listScenes, sceneImages } from '../src/main/scenes/repo'
import { coverUrl, thumbnailUrl } from '../src/shared/thumbnail-url'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'en-US' },
  BrowserWindow: {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))

const T1 = '2026-01-02 03:04:05'
const T2 = '2026-02-03 04:05:06'

async function fetchThumb(url: string): Promise<string | null> {
  return (await thumbnailForUrl(new URL(url)))?.toString('hex') ?? null
}

async function fetchCover(url: string): Promise<string | null> {
  return (await sceneCoverForUrl(new URL(url)))?.toString('hex') ?? null
}

describe('thumbnail URLs', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nais3-thumbnail-urls-'))
    environment.directory = root
    initDb()
  })
  afterEach(() => {
    closeDb()
    rmSync(root, { recursive: true, force: true })
  })

  it('lists history items with protocol URLs that resolve to the stored thumbnail', async () => {
    getDb().exec(`
      INSERT INTO images (id, file_path, thumbnail, payload_json, created_at, seq) VALUES
        (1, '/a.png', X'0102', '{}', '${T1}', 1),
        (2, '/b.png', NULL, '{}', '${T1}', 2),
        (3, '/c.png', X'', '{}', '${T1}', 3);
    `)
    const { items } = listImages(10, 0)
    expect(items.map((i) => [i.id, i.thumbnailUrl])).toEqual([
      [3, ''],
      [2, ''],
      [1, thumbnailUrl('image', 1, T1, 2)]
    ])
    expect(items[2]).not.toHaveProperty('thumbnail')
    expect(items[2].thumbnailUrl).toBe(
      'nais-image://local/?thumb=image&id=1&v=2026-01-02%2003%3A04%3A05~2'
    )
    expect(await fetchThumb(items[2].thumbnailUrl)).toBe('0102')
  })

  it('changes the URL when a deleted id is reused', async () => {
    const db = getDb()
    db.exec(`INSERT INTO images (id, file_path, thumbnail, payload_json, created_at, seq)
             VALUES (1, '/a.png', X'01', '{}', '${T1}', 1)`)
    const before = listImages(1, 0).items[0].thumbnailUrl
    db.exec('DELETE FROM images')
    db.exec(`INSERT INTO images (file_path, thumbnail, payload_json, created_at, seq)
             VALUES ('/b.png', X'02', '{}', '${T2}', 2)`)
    const after = listImages(1, 0).items[0]
    expect(after.id).toBe(1)
    expect(after.thumbnailUrl).not.toBe(before)
    expect(await fetchThumb(after.thumbnailUrl)).toBe('02')
  })

  it('changes the URL when a deleted id is reused within the same second', async () => {
    // created_at has second precision — the thumbnail size keeps the URLs apart
    const db = getDb()
    db.exec(`INSERT INTO images (id, file_path, thumbnail, payload_json, created_at, seq)
             VALUES (1, '/a.png', X'01', '{}', '${T1}', 1)`)
    const before = listImages(1, 0).items[0].thumbnailUrl
    db.exec('DELETE FROM images')
    db.exec(`INSERT INTO images (file_path, thumbnail, payload_json, created_at, seq)
             VALUES ('/b.png', X'0203', '{}', '${T1}', 2)`)
    const after = listImages(1, 0).items[0]
    expect(after.id).toBe(1)
    expect(after.thumbnailUrl).not.toBe(before)
    expect(await fetchThumb(after.thumbnailUrl)).toBe('0203')
  })

  it('rejects unknown sources, bad ids and missing rows', async () => {
    getDb().exec(`INSERT INTO images (id, file_path, thumbnail, payload_json)
                  VALUES (1, '/a.png', X'01', '{}')`)
    expect(await fetchThumb('nais-image://local/?thumb=image&id=1')).toBe('01')
    expect(await fetchThumb('nais-image://local/?thumb=images&id=1')).toBeNull()
    expect(await fetchThumb('nais-image://local/?thumb=character_prompts&id=1')).toBeNull()
    expect(await fetchThumb('nais-image://local/?thumb=image&id=1.5')).toBeNull()
    expect(await fetchThumb('nais-image://local/?thumb=image&id=1%20OR%201')).toBeNull()
    expect(await fetchThumb('nais-image://local/?thumb=image&id=2')).toBeNull()
    expect(await fetchThumb('nais-image://local/?thumb=library&id=1')).toBeNull()
  })

  it('points scene cards at the cover and drops thumbnails from scene pages', async () => {
    getDb().exec(`
      INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES (1, 1, 'a', 0), (2, 1, 'b', 1);
      INSERT INTO images (id, file_path, thumbnail, payload_json, scene_id, favorite, created_at) VALUES
        (1, '/s1/1.png', X'01', '{}', 1, 1, '${T1}'),
        (2, '/s1/2.png', X'02', '{}', 1, 0, '${T2}'),
        (3, '/s2/3.png', NULL, '{}', 2, 0, '${T2}');
    `)
    const [a, b] = listScenes(1)
    expect(a).toMatchObject({ thumbnailUrl: coverUrl(1, 1, T1), thumbnailPath: '/s1/1.png' })
    expect(a.thumbnailUrl).toBe('nais-image://local/?cover=1&v=1~2026-01-02%2003%3A04%3A05')
    // The file is gone, so the cover is the stored thumbnail
    expect(await fetchCover(a.thumbnailUrl)).toBe('01')
    // Neither a file nor a stored thumbnail: the card falls back to the original via thumbnailPath.
    expect(b).toMatchObject({ thumbnailUrl: coverUrl(2, 3, T2), thumbnailPath: '/s2/3.png' })
    expect(await fetchCover(b.thumbnailUrl)).toBeNull()
    expect(sceneImages(1, 10, 0).items[0]).toEqual({
      id: 2,
      filePath: '/s1/2.png',
      seed: null,
      favorite: false
    })
  })

  it('serves library items and stack covers by URL', async () => {
    getDb().exec(`
      INSERT INTO library_stacks (id, name) VALUES (1, 'full'), (2, 'empty'), (3, 'no thumb');
      INSERT INTO library_images (id, file_path, thumbnail, stack_id, created_at) VALUES
        (1, '/l1', X'01', NULL, '${T1}'),
        (2, '/l2', NULL, NULL, '${T1}'),
        (3, '/l3', X'03', 1, '${T1}'),
        (4, '/l4', X'04', 1, '${T2}'),
        (5, '/l5', NULL, 3, '${T2}');
    `)
    const root = listLibrary(null, 10, 0)
    expect(root.items.map((i) => [i.id, i.thumbnailUrl])).toEqual([
      [2, ''],
      [1, thumbnailUrl('library', 1, T1, 1)]
    ])
    expect(await fetchThumb(root.items[1].thumbnailUrl)).toBe('01')
    expect(root.stacks).toEqual([
      { id: 3, name: 'no thumb', count: 1, coverUrl: '' },
      { id: 2, name: 'empty', count: 0, coverUrl: '' },
      { id: 1, name: 'full', count: 2, coverUrl: thumbnailUrl('library', 4, T2, 1) }
    ])
    expect(await fetchThumb(root.stacks[2].coverUrl)).toBe('04')
  })
})
