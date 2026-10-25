import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { allocateSeq } from '../src/main/db/history'
import { migrations } from '../src/main/db/migrations'
import { getSetting, setSetting } from '../src/main/db/settings'
import { listImages } from '../src/main/images/storage'
import {
  bulkClearImages,
  clearAllImages,
  deleteImage,
  deleteNonFavorites,
  getScene,
  listScenes,
  sceneImages
} from '../src/main/scenes/repo'

const environment = vi.hoisted(() => ({ directory: '', trashItem: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'ko' },
  BrowserWindow: {},
  dialog: {},
  shell: { trashItem: environment.trashItem },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let root: string
let files: string
const path = (): string => join(environment.directory, 'nais3.db')
const backups = (): string => join(environment.directory, 'backups')
const file = (name: string): string => join(files, name)

/**
 * A v20 workspace as 1.0.29 leaves it, with two scenes and a main generation.
 * Scene 1: images 1 (favorite), 2, 3. Scene 2: image 5. Image 4 is a main generation.
 */
function seedV20(settings: Record<string, string> = {}): void {
  const db = new Database(path())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (let v = 0; v < migrations.length; v++)
    db.transaction(() => {
      migrations[v](db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  db.exec(`
    INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES (1, 1, 'a', 0), (2, 1, 'b', 1);
  `)
  const insert = db.prepare(
    'INSERT INTO images (id, file_path, thumbnail, payload_json, scene_id, favorite) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const [id, scene, favorite] of [
    [1, 1, 1],
    [2, 1, 0],
    [3, 1, 0],
    [4, null, 0],
    [5, 2, 0]
  ] as const) {
    const name = file(`${id}.png`)
    writeFileSync(name, `image ${id}`)
    insert.run(id, name, Buffer.from([id]), '{}', scene, favorite)
  }
  for (const [key, value] of Object.entries(settings))
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value)
  db.close()
}

const historyIds = (): number[] => listImages(100, 0).items.map((i) => i.id)
const galleryIds = (sceneId: number): number[] =>
  sceneImages(sceneId, 100, 0).items.map((i) => i.id)

/** Everything a scene shows: cards (count, cover, favorite flag), galleries and the files */
function sceneState(): unknown {
  return {
    cards: listScenes(1),
    galleries: [galleryIds(1), galleryIds(2), sceneImages(1, 100, 0, true).items],
    rows: getDb().prepare('SELECT id, file_path, scene_id, favorite FROM images ORDER BY id').all(),
    files: readdirSync(files).sort()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-history-'))
  environment.directory = join(root, 'workspace')
  files = join(root, 'outputs')
  mkdirSync(environment.directory)
  mkdirSync(files)
  environment.trashItem.mockReset()
  environment.trashItem.mockResolvedValue(undefined)
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('history sequence numbers', () => {
  it('numbers existing rows in id order once, after a snapshot', () => {
    seedV20()
    initDb()
    const db = getDb()
    expect(db.prepare('SELECT id, seq FROM images ORDER BY id').all()).toEqual(
      [1, 2, 3, 4, 5].map((id) => ({ id, seq: id }))
    )
    expect(db.prepare('SELECT next_seq FROM history_state').pluck().get()).toBe(6)
    expect(db.prepare('SELECT name FROM applied_jobs ORDER BY name').pluck().all()).toEqual([
      'assign-image-seq',
      'delete-to-trash-setting'
    ])
    expect(readdirSync(backups())).toEqual(['pre-job-assign-image-seq.db'])
    expect(historyIds()).toEqual([5, 4, 3, 2, 1])
  })

  it('numbers rows that an older app added while downgraded on the next start', () => {
    seedV20()
    initDb()
    clearAllImages()
    closeDb()
    // 1.0.29 inserts without seq
    const db = new Database(path())
    db.prepare(
      "INSERT INTO images (file_path, thumbnail, payload_json) VALUES ('/old.png', X'01', '{}')"
    ).run()
    db.close()

    initDb()
    expect(
      getDb().prepare("SELECT seq FROM images WHERE file_path = '/old.png'").pluck().get()
    ).toBe(6)
    expect(listImages(100, 0).items.map((i) => i.filePath)).toEqual(['/old.png'])
  })

  it('keeps allocating above the highest seq, so a new output lands past a clear', () => {
    seedV20()
    initDb()
    clearAllImages()
    const db = getDb()
    db.prepare(
      'INSERT INTO images (file_path, thumbnail, payload_json, seq) VALUES (?, ?, ?, ?)'
    ).run('/new.png', Buffer.from([9]), '{}', allocateSeq(db))
    expect(listImages(100, 0)).toMatchObject({ total: 1, items: [{ filePath: '/new.png' }] })
  })

  it('carries the old delete-file option over to the trash option', () => {
    seedV20({ history_delete_file: '1' })
    initDb()
    expect(getSetting('delete_to_trash')).toBe('1')
    // The old key stays for an app that is downgraded again
    expect(getSetting('history_delete_file')).toBe('1')
  })

  it('leaves the trash option off when the old option was off', () => {
    seedV20({ history_delete_file: '0' })
    initDb()
    expect(getSetting('delete_to_trash')).toBeNull()
  })
})

describe('history clear and delete', () => {
  beforeEach(() => {
    seedV20()
    initDb()
  })

  it('clears history without touching scene rows, counts, covers, favorites or files', () => {
    const before = sceneState()
    expect(clearAllImages()).toBe(5)
    expect(listImages(100, 0)).toEqual({ items: [], total: 0 })
    expect(sceneState()).toEqual(before)
    expect(getScene(1)?.imageCount).toBe(3)
  })

  it('hides a history entry from history only', () => {
    const before = sceneState()
    return deleteImage(2, 'history').then((result) => {
      expect(result).toEqual({ mode: 'hide', results: [{ id: 2, ok: true }] })
      expect(historyIds()).toEqual([5, 4, 3, 1])
      expect(listImages(100, 0).total).toBe(4)
      expect(sceneState()).toEqual(before)
    })
  })

  it('hides a scene image from the scene gallery only', async () => {
    await deleteImage(3, 'scene')
    expect(galleryIds(1)).toEqual([2, 1])
    expect(getScene(1)?.imageCount).toBe(2)
    expect(historyIds()).toEqual([5, 4, 3, 2, 1])
    expect(existsSync(file('3.png'))).toBe(true)
  })

  it('keeps the two scopes apart for the same image', async () => {
    await deleteImage(2, 'history')
    await deleteImage(3, 'scene')
    expect(historyIds()).toEqual([5, 4, 3, 1])
    expect(galleryIds(1)).toEqual([2, 1])
  })

  it('hides non-favorites and cleared scenes from galleries, leaving history and files', async () => {
    const declutter = await deleteNonFavorites(1)
    expect(declutter.results.map((r) => r.id).sort()).toEqual([2, 3])
    expect(galleryIds(1)).toEqual([1])
    expect(listScenes(1)[0]).toMatchObject({ imageCount: 1, hasFavorite: true })

    const cleared = await bulkClearImages([1, 2])
    expect(cleared).toEqual({ mode: 'hide', results: [1, 5].map((id) => ({ id, ok: true })) })
    expect(listScenes(1).map((s) => s.imageCount)).toEqual([0, 0])
    expect(listScenes(1)[0]).toMatchObject({ thumbnailPath: '', hasFavorite: false })
    expect(historyIds()).toEqual([5, 4, 3, 2, 1])
    expect(readdirSync(files)).toHaveLength(5)
    expect(environment.trashItem).not.toHaveBeenCalled()
  })

  it('keeps the memory:// contract: deleting an unsaved image drops its row', async () => {
    getDb()
      .prepare('INSERT INTO images (file_path, thumbnail, payload_json, seq) VALUES (?, ?, ?, 6)')
      .run('memory://temp.png', Buffer.from([1]), '{}')
    const id = listImages(1, 0).items[0].id
    await deleteImage(id, 'history')
    expect(getDb().prepare('SELECT COUNT(*) FROM images WHERE id = ?').pluck().get(id)).toBe(0)
  })
})

describe('deleting with the trash option on', () => {
  beforeEach(() => {
    seedV20()
    initDb()
    setSetting('delete_to_trash', '1')
  })

  it('moves the file to the trash and hides it everywhere', async () => {
    const result = await deleteImage(2, 'history')
    expect(result).toEqual({ mode: 'trash', results: [{ id: 2, ok: true }] })
    expect(environment.trashItem).toHaveBeenCalledWith(file('2.png'))
    expect(historyIds()).not.toContain(2)
    expect(galleryIds(1)).not.toContain(2)
    // The row stays as metadata; only the trash removes the file
    expect(getDb().prepare('SELECT COUNT(*) FROM images WHERE id = 2').pluck().get()).toBe(1)
  })

  it('reports a trash failure and keeps the item and its file', async () => {
    environment.trashItem.mockRejectedValueOnce(new Error('Trash is not available'))
    const result = await deleteImage(2, 'scene')
    expect(result).toEqual({
      mode: 'trash',
      results: [{ id: 2, ok: false, error: 'Trash is not available' }]
    })
    expect(galleryIds(1)).toContain(2)
    expect(historyIds()).toContain(2)
    expect(existsSync(file('2.png'))).toBe(true)
  })

  it('returns per-file results for a batch and keeps the files that failed', async () => {
    environment.trashItem.mockImplementation(async (name: string) => {
      if (name === file('3.png')) throw new Error('Locked')
    })
    const result = await deleteNonFavorites(1)
    expect(result.mode).toBe('trash')
    expect(result.results).toEqual(
      expect.arrayContaining([
        { id: 2, ok: true },
        { id: 3, ok: false, error: 'Locked' }
      ])
    )
    expect(galleryIds(1)).toEqual([3, 1])
    expect(existsSync(file('3.png'))).toBe(true)
  })

  it('hides a row whose file is already gone without calling the trash', async () => {
    rmSync(file('5.png'))
    expect(await bulkClearImages([2])).toEqual({ mode: 'trash', results: [{ id: 5, ok: true }] })
    expect(environment.trashItem).not.toHaveBeenCalled()
    expect(galleryIds(2)).toEqual([])
  })

  it('still clears history without moving anything to the trash', () => {
    clearAllImages()
    expect(environment.trashItem).not.toHaveBeenCalled()
    expect(readdirSync(files)).toHaveLength(5)
  })
})
