import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// The app's sharp, not 'sharp' itself (see thumbnail-cache.integration.ts)
import sharp from '../src/main/sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { allocateSeq, hideImages } from '../src/main/db/history'
import { locate, recordIntent, registerMedia } from '../src/main/db/media'
import { setSetting } from '../src/main/db/settings'
import { externalImportRoot, importExternalImages } from '../src/main/images/external'
import { reindexMedia } from '../src/main/images/reindex'
import { saveGeneratedImage, scenesRoot, syncMediaRoots } from '../src/main/images/storage'
import { sceneFolderToOpen, sceneFolders } from '../src/main/scenes/folders'
import { createScene, duplicateScene, importScenesJson } from '../src/main/scenes/repo'

const environment = vi.hoisted(() => ({ directory: '', importFile: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'en-US', getVersion: () => '0' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [environment.importFile] })
  },
  shell: { trashItem: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let root: string

const registrations = (): {
  seq: number
  root_id: number
  rel_path: string
  source: string
  scene_id: number | null
}[] =>
  getDb()
    .prepare(
      'SELECT seq, root_id, rel_path, source, scene_id FROM media_registrations ORDER BY seq'
    )
    .all() as never

const rootId = (path: string): number =>
  getDb().prepare('SELECT id FROM media_roots WHERE path = ?').pluck().get(path) as number

function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: '#2050d0' } })
    .png()
    .toBuffer()
}

function save(sceneId?: number, seed = 1): ReturnType<typeof saveGeneratedImage> {
  return png().then((bytes) =>
    saveGeneratedImage({
      png: bytes,
      sentPayload: '{}',
      seed,
      kind: sceneId ? 'scene' : 't2i',
      sceneId
    })
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-scene-folders-'))
  environment.directory = root
  initDb()
  getDb().exec(
    `INSERT INTO scene_presets (id, name, sort_order) VALUES (1, 'p', 0)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name;
     INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES (1, 1, 'legacy', 0);
     INSERT INTO gen_scenes (id, preset_id, name, sort_order, folder_uuid)
       VALUES (2, 1, 'CON.', 1, 'uuid-2');`
  )
})

afterEach(() => {
  vi.useRealTimers()
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('new scenes get a UUID folder', () => {
  it('sets folder_uuid on create, duplicate and JSON import', async () => {
    const created = createScene(1, 'made')
    const copy = duplicateScene(created)
    environment.importFile = join(root, 'scenes.json')
    writeFileSync(environment.importFile, JSON.stringify({ scenes: [{ name: 'imported' }] }))
    expect(await importScenesJson(1)).toBe(1)

    const uuids = getDb()
      .prepare('SELECT folder_uuid FROM gen_scenes WHERE id > 2 ORDER BY id')
      .pluck()
      .all() as string[]
    expect(uuids).toHaveLength(3)
    for (const uuid of uuids) expect(uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Set(uuids).size).toBe(3)
    expect(copy).toBeGreaterThan(created)
  })

  it('writes <uuid>/<name>_N, numbering past files of any extension, and never overwrites', async () => {
    const dir = join(scenesRoot(), 'uuid-2')
    mkdirSync(dir, { recursive: true })
    // 이름은 Windows 예약어·끝 점을 피한다 — 'CON.' → '_CON'
    writeFileSync(join(dir, '_CON_4.webp'), 'not mine')
    writeFileSync(join(dir, '_con_7.PNG'), 'not mine either')

    const first = await save(2)
    const second = await save(2)
    expect(first.filePath).toBe(join(dir, '_CON_8.png'))
    expect(second.filePath).toBe(join(dir, '_CON_9.png'))
    expect(readFileSync(join(dir, '_CON_4.webp'), 'utf8')).toBe('not mine')

    const scenes = rootId(scenesRoot())
    expect(registrations().map((r) => [r.root_id, r.rel_path, r.scene_id])).toEqual([
      [scenes, 'uuid-2/_CON_8.png', 2],
      [scenes, 'uuid-2/_CON_9.png', 2]
    ])
    expect(
      getDb().prepare('SELECT rel_dir, role FROM scene_sources WHERE scene_id = 2').all()
    ).toEqual([{ rel_dir: 'uuid-2', role: 'write' }])
  })

  it('keeps existing scenes in their name folder', async () => {
    const saved = await save(1)
    expect(saved.filePath).toBe(join(scenesRoot(), 'p', 'legacy', 'legacy.png'))
    expect((await save(1)).filePath).toBe(join(scenesRoot(), 'p', 'legacy', 'legacy_2.png'))
  })

  it('decides scene-ness by id: a scene deleted mid-generation saves to the main folder', async () => {
    setSetting('date_folders', '0')
    const saved = await save(999)
    expect(saved.filePath.startsWith(join(root, 'NAIS3', 'NAIS3_output'))).toBe(true)
    expect(registrations()[0].scene_id).toBeNull()
    expect(getDb().prepare('SELECT scene_id FROM images').pluck().get()).toBeNull()
  })

  it('numbers main outputs that collide in the same second instead of overwriting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-25T05:00:00Z'))
    setSetting('date_folders', '0')
    const a = await save(undefined, 0)
    const b = await save(undefined, 0)
    expect(a.filePath).toMatch(/NAIS3_2026-10-25T05-00-00_0\.png$/)
    expect(b.filePath).toMatch(/NAIS3_2026-10-25T05-00-00_0_2\.png$/)
    expect(readdirSync(join(root, 'NAIS3', 'NAIS3_output'))).toHaveLength(2)
  })
})

describe('scene folder resolver', () => {
  it('moves the write role to the folder of the latest output', async () => {
    await save(1)
    setSetting('scene_save_dir', join(root, 'moved'))
    await save(1)
    const rows = getDb()
      .prepare(
        `SELECT r.path, s.rel_dir, s.role FROM scene_sources s JOIN media_roots r ON r.id = s.root_id
         WHERE s.scene_id = 1 ORDER BY s.id`
      )
      .all()
    expect(rows).toEqual([
      { path: join(root, 'NAIS3', 'NAIS3_scene'), rel_dir: 'p/legacy', role: 'read' },
      { path: join(root, 'moved'), rel_dir: 'p/legacy', role: 'write' }
    ])
    expect(sceneFolders(1)).toEqual({
      write: join(root, 'moved', 'p', 'legacy'),
      read: [join(root, 'NAIS3', 'NAIS3_scene', 'p', 'legacy')]
    })
  })

  it('opens the write folder, or the newest existing read folder before the first output', () => {
    syncMediaRoots()
    expect(sceneFolderToOpen(2)).toBeNull()
    const old = join(scenesRoot(), 'p', 'CON')
    mkdirSync(old, { recursive: true })
    getDb()
      .prepare(
        `INSERT INTO scene_sources (scene_id, root_id, rel_dir, dir_key, role)
         VALUES (2, ?, 'p/CON', 'p/CON', 'read')`
      )
      .run(rootId(scenesRoot()))
    expect(sceneFolderToOpen(2)).toBe(old)
    mkdirSync(join(scenesRoot(), 'uuid-2'))
    expect(sceneFolderToOpen(2)).toBe(join(scenesRoot(), 'uuid-2'))
    expect(sceneFolderToOpen(999)).toBeNull()
  })
})

describe('external images', () => {
  it('copies dropped images into the import folder and registers the copy', async () => {
    const bytes = await png()
    const base64 = bytes.toString('base64')
    const result = await importExternalImages([
      { name: 'photo.png', base64 },
      { name: 'notes.txt', base64: Buffer.from('hello').toString('base64') },
      { name: 'photo.png', base64: `data:image/png;base64,${base64}` }
    ])
    expect(result).toEqual({ imported: 2, skipped: 1 })

    const month = readdirSync(externalImportRoot())
    expect(month).toEqual([expect.stringMatching(/^\d{4}-\d{2}$/)])
    const dir = join(externalImportRoot(), month[0])
    expect(readdirSync(dir).sort()).toEqual(['photo.png', 'photo_2.png'])
    expect(readFileSync(join(dir, 'photo.png')).equals(bytes)).toBe(true)

    const external = rootId(externalImportRoot())
    expect(registrations().map((r) => [r.root_id, r.rel_path, r.source])).toEqual([
      [external, `${month[0]}/photo.png`, 'external'],
      [external, `${month[0]}/photo_2.png`, 'external']
    ])
    expect(getDb().prepare('SELECT kind, file_path FROM images ORDER BY id').all()).toEqual([
      { kind: 'external', file_path: join(dir, 'photo.png') },
      { kind: 'external', file_path: join(dir, 'photo_2.png') }
    ])
    expect(getDb().prepare('SELECT COUNT(*) FROM media_intents').pluck().get()).toBe(0)
  })
})

describe('media reindex', () => {
  it('registers unregistered images by location, keeping seq and hidden state', async () => {
    setSetting('date_folders', '0')
    const kept = await save()
    const keptSeq = registrations()[0].seq
    hideImages(getDb(), [kept.id], 'history')

    const output = join(root, 'NAIS3', 'NAIS3_output')
    const bytes = await png()
    mkdirSync(join(output, 'sub'), { recursive: true })
    mkdirSync(join(output, '.cache'), { recursive: true })
    writeFileSync(join(output, 'sub', 'foreign.jpg'), bytes) // NAIS가 만들지 않은 이미지도
    writeFileSync(join(output, '.hidden.png'), bytes)
    writeFileSync(join(output, '.cache', 'thumb.png'), bytes)
    writeFileSync(join(output, 'readme.txt'), 'not an image')
    const scenes = scenesRoot()
    mkdirSync(join(scenes, 'uuid-2'), { recursive: true })
    writeFileSync(join(scenes, 'uuid-2', 'found.png'), bytes)
    // 쓰는 중인 출력 — 의도가 있으면 저장이 등록한다
    writeFileSync(join(output, 'pending.png'), bytes)
    recordIntent(getDb(), {
      ...locate(getDb(), join(output, 'pending.png'))!,
      kind: 't2i',
      seed: 1,
      sceneId: null
    })

    const progress: unknown[] = []
    const result = await reindexMedia((p) => progress.push(p))
    expect(result).toEqual({ scanned: 4, registered: 2 })
    expect(progress.at(-1)).toEqual(result)

    const rows = registrations()
    expect(rows.find((r) => r.seq === keptSeq)?.source).toBe('generated')
    expect(
      getDb().prepare('SELECT scope FROM media_hidden WHERE seq = ?').pluck().all(keptSeq)
    ).toEqual(['history'])
    expect(rows.filter((r) => r.source === 'reindex').map((r) => [r.rel_path, r.scene_id])).toEqual(
      [
        ['sub/foreign.jpg', null],
        ['uuid-2/found.png', 2]
      ]
    )
    expect(
      Math.min(...rows.filter((r) => r.source === 'reindex').map((r) => r.seq))
    ).toBeGreaterThan(keptSeq)

    // 다시 돌려도 같은 결과 — 위치로 거른다
    expect(await reindexMedia()).toEqual({ scanned: 4, registered: 0 })
    expect(existsSync(join(output, '.hidden.png'))).toBe(true)
  })

  it('walks a root nested in another root once, against the deeper root', async () => {
    const output = join(root, 'out')
    setSetting('save_dir', output)
    setSetting('scene_save_dir', join(output, 'scenes'))
    syncMediaRoots()
    mkdirSync(join(output, 'scenes', 'p', 'legacy'), { recursive: true })
    writeFileSync(join(output, 'scenes', 'p', 'legacy', 'x.png'), await png())

    expect(await reindexMedia()).toEqual({ scanned: 1, registered: 1 })
    expect(registrations()).toEqual([
      expect.objectContaining({
        root_id: rootId(join(output, 'scenes')),
        rel_path: 'p/legacy/x.png'
      })
    ])
  })

  it('never un-hides a registration that was hidden before the reindex', async () => {
    syncMediaRoots()
    const output = join(root, 'NAIS3', 'NAIS3_output')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'old.png'), await png())
    const seq = registerMedia(getDb(), {
      ...locate(getDb(), join(output, 'old.png'))!,
      seq: allocateSeq(getDb()),
      source: 'manual',
      sceneId: null
    }).seq
    getDb().prepare(`INSERT INTO media_hidden (seq, scope) VALUES (?, 'history')`).run(seq)

    expect(await reindexMedia()).toEqual({ scanned: 1, registered: 0 })
    expect(getDb().prepare('SELECT COUNT(*) FROM media_hidden').pluck().get()).toBe(1)
  })
})
