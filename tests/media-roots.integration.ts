import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// The app's sharp, not 'sharp' itself (see thumbnail-cache.integration.ts)
import sharp from '../src/main/sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { allocateSeq, assignMissingSeqs, clearHistory, hideImages } from '../src/main/db/history'
import {
  locate,
  mediaCollisions,
  reclaimUnregistered,
  recordIntent,
  registerMedia
} from '../src/main/db/media'
import { setSetting } from '../src/main/db/settings'
import { recoverPendingOutputs } from '../src/main/images/media-recovery'
import { buildNaisMetadata, embedNaisMetadata } from '../src/main/images/nais-metadata'
import {
  imagesRoot,
  isUnderImagesRoot,
  listImages,
  saveGeneratedImage,
  sceneFolderInfo,
  sceneWriteDir,
  scenesRoot,
  syncMediaRoots
} from '../src/main/images/storage'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'en-US', getVersion: () => '0' },
  BrowserWindow: {},
  dialog: {},
  shell: { trashItem: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let root: string

interface RootRow {
  id: number
  kind: string
  path: string
  status: string
}

const roots = (): RootRow[] =>
  getDb().prepare('SELECT id, kind, path, status FROM media_roots ORDER BY id').all() as RootRow[]

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

const count = (table: string): number =>
  getDb().prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number

function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: '#d02020' } })
    .png()
    .toBuffer()
}

/** 옛 앱·이전 버전이 넣은 images 행 */
function insertImage(path: string, options: { scene?: number; seq?: number | null } = {}): number {
  const seq = options.seq === undefined ? allocateSeq(getDb()) : options.seq
  return Number(
    getDb()
      .prepare(
        `INSERT INTO images (file_path, thumbnail, kind, payload_json, scene_id, seq)
         VALUES (?, x'01', 't2i', '{}', ?, ?)`
      )
      .run(path, options.scene ?? null, seq).lastInsertRowid
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-media-roots-'))
  environment.directory = root
  initDb()
  getDb().exec(`INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES (1, 1, 'a', 0)`)
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('media roots', () => {
  it('registers the current save folders, and keeps the old one as past when they change', () => {
    syncMediaRoots()
    expect(roots()).toEqual([
      { id: 1, kind: 'output', path: imagesRoot(), status: 'current' },
      { id: 2, kind: 'scene', path: scenesRoot(), status: 'current' }
    ])

    const moved = join(root, 'elsewhere')
    setSetting('save_dir', moved)
    syncMediaRoots()
    // 새 폴더는 새 루트, 예전 루트는 경로 그대로 past — 재연결하지 않는다
    expect(roots()).toEqual([
      { id: 1, kind: 'output', path: join(root, 'NAIS3', 'NAIS3_output'), status: 'past' },
      { id: 2, kind: 'scene', path: scenesRoot(), status: 'current' },
      { id: 3, kind: 'output', path: moved, status: 'current' }
    ])

    // 되돌리면 같은 루트가 다시 current — 새 행도, 지운 행도 없다
    setSetting('save_dir', '')
    syncMediaRoots()
    expect(roots().map((r) => [r.id, r.status])).toEqual([
      [1, 'current'],
      [2, 'current'],
      [3, 'past']
    ])
  })

  it('reuses one root when the main and scene folders are the same', () => {
    const shared = join(root, 'shared')
    setSetting('save_dir', shared)
    setSetting('scene_save_dir', shared)
    syncMediaRoots()
    expect(roots()).toEqual([{ id: 1, kind: 'output', path: shared, status: 'current' }])
  })

  it('keeps past save folders readable, but not folders restored from another device', () => {
    const first = join(root, 'first')
    setSetting('save_dir', first)
    syncMediaRoots()
    setSetting('save_dir', join(root, 'second'))
    syncMediaRoots()
    expect(isUnderImagesRoot(join(first, '2026-01', 'a.png'))).toBe(true)
    expect(isUnderImagesRoot(join(root, 'unrelated', 'a.png'))).toBe(false)

    const foreign = join(root, 'foreign')
    getDb()
      .prepare(
        `INSERT INTO media_roots (kind, path, path_key, status) VALUES ('output', ?, ?, 'unmapped')`
      )
      .run(foreign, foreign)
    expect(isUnderImagesRoot(join(foreign, 'a.png'))).toBe(false)
  })
})

describe('locator', () => {
  it('finds the deepest root and keeps the raw relative path, matching NFD paths by NFC', () => {
    const nfc = join(root, 'café')
    const nfd = join(root, 'café')
    setSetting('save_dir', nfc)
    setSetting('scene_save_dir', join(nfc, 'scenes'))
    const ids = syncMediaRoots()

    expect(locate(getDb(), join(nfc, '2026-01', 'a.png'))).toEqual({
      rootId: ids.output,
      relPath: '2026-01/a.png'
    })
    expect(locate(getDb(), join(nfc, 'scenes', 'p', 's', 'a.png'))).toEqual({
      rootId: ids.scene,
      relPath: 'p/s/a.png'
    })
    // NFD로 적힌 경로도 같은 루트 — 상대 경로는 파일 경로의 원문 그대로
    expect(locate(getDb(), join(nfd, 'résumé.png'))).toEqual({
      rootId: ids.output,
      relPath: 'résumé.png'
    })
    expect(locate(getDb(), join(nfd, 'é.png'))?.relPath).toBe('é.png')
    expect(locate(getDb(), join(root, 'outside.png'))).toBeNull()
    expect(locate(getDb(), 'relative/a.png')).toBeNull()
  })

  it('reports paths that differ only in normalization, and never merges them', () => {
    const ids = syncMediaRoots()
    const db = getDb()
    registerMedia(db, {
      rootId: ids.output,
      relPath: 'é.png',
      seq: allocateSeq(db),
      source: 'manual'
    })
    registerMedia(db, {
      rootId: ids.output,
      relPath: 'é.png',
      seq: allocateSeq(db),
      source: 'manual'
    })
    db.prepare(
      `INSERT INTO media_roots (kind, path, path_key, status) VALUES ('output', ?, ?, 'past')`
    ).run(join(root, 'café'), join(root, 'café'))
    db.prepare(
      `INSERT INTO media_roots (kind, path, path_key, status) VALUES ('output', ?, ?, 'past')`
    ).run(join(root, 'café'), join(root, 'café'))

    expect(count('media_registrations')).toBe(2)
    expect(mediaCollisions(db)).toEqual({
      roots: [[join(root, 'café'), join(root, 'café')]],
      files: [{ rootId: ids.output, relPaths: ['é.png', 'é.png'] }]
    })
  })
})

describe('saving outputs', () => {
  it('registers each output with its own seq in the same transaction, and leaves no intent', async () => {
    // 기존 씬(folder_uuid 없음)은 씬루트/<프리셋>/<씬 이름>/ — 이름은 씬 id로 DB에서 읽는다
    getDb().exec(
      `INSERT INTO scene_presets (id, name, sort_order) VALUES (1, 'p', 0)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name`
    )
    const main = await saveGeneratedImage({
      png: await png(),
      sentPayload: '{}',
      seed: 7,
      kind: 't2i'
    })
    const scene = await saveGeneratedImage({
      png: await png(),
      sentPayload: '{}',
      seed: 8,
      kind: 'scene',
      sceneId: 1
    })
    const seqOf = (id: number): number =>
      getDb().prepare('SELECT seq FROM images WHERE id = ?').pluck().get(id) as number
    const [output, sceneRoot] = roots()
    expect(registrations()).toEqual([
      {
        seq: seqOf(main.id),
        root_id: output.id,
        rel_path: expect.stringMatching(/^\d{4}-\d{2}\/NAIS3_.+_7\.png$/),
        source: 'generated',
        scene_id: null
      },
      {
        seq: seqOf(scene.id),
        root_id: sceneRoot.id,
        rel_path: 'p/a/a.png',
        source: 'generated',
        scene_id: 1
      }
    ])
    expect(
      getDb().prepare('SELECT scene_id, root_id, rel_dir, role FROM scene_sources').all()
    ).toEqual([{ scene_id: 1, root_id: sceneRoot.id, rel_dir: 'p/a', role: 'write' }])
    expect(count('media_intents')).toBe(0)
  })

  it('registers outputs under the new folder after the save folder changes', async () => {
    syncMediaRoots()
    setSetting('date_folders', '0')
    setSetting('save_dir', join(root, 'next'))
    const saved = await saveGeneratedImage({
      png: await png(),
      sentPayload: '{}',
      seed: 1,
      kind: 't2i'
    })
    const next = roots().find((r) => r.path === join(root, 'next'))!
    expect(next.status).toBe('current')
    expect(locate(getDb(), saved.filePath)?.rootId).toBe(next.id)
    expect(registrations()[0].root_id).toBe(next.id)
  })
})

describe('naming after a trashed output', () => {
  beforeEach(() => {
    getDb().exec(
      `INSERT INTO scene_presets (id, name, sort_order) VALUES (1, 'p', 0)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name`
    )
  })

  const sceneOutput = async (image?: Buffer): Promise<{ id: number; filePath: string }> =>
    saveGeneratedImage({
      png: image ?? (await png()),
      sentPayload: '{}',
      seed: 8,
      kind: 'scene',
      sceneId: 1
    })

  /** 휴지통으로 보낸 것처럼 — 행과 등록은 남고 파일만 없다 */
  async function trashedNewest(): Promise<{ id: number; filePath: string }> {
    await sceneOutput()
    const newest = await sceneOutput()
    expect(newest.filePath).toMatch(/[\\/]a_2\.png$/)
    hideImages(getDb(), [newest.id], 'scene')
    rmSync(newest.filePath)
    return newest
  }

  it('gives the next output a new name, location and seq', async () => {
    const trashed = await trashedNewest()
    const next = await sceneOutput()
    expect(next.filePath).toMatch(/[\\/]a_3\.png$/)
    const seqOf = (id: number): number =>
      getDb().prepare('SELECT seq FROM images WHERE id = ?').pluck().get(id) as number
    expect(registrations().map((r) => [r.rel_path, r.seq])).toEqual([
      ['p/a/a.png', expect.any(Number)],
      ['p/a/a_2.png', seqOf(trashed.id)],
      ['p/a/a_3.png', seqOf(next.id)]
    ])
    expect(listImages(10, 0).items[0].id).toBe(next.id)
  })

  it('numbers past a trashed output in a UUID scene folder too', async () => {
    const uuid = '0b6f3c1e-8a52-4d7e-9f10-2c4b5a6d7e8f'
    getDb().prepare('UPDATE gen_scenes SET folder_uuid = ? WHERE id = 1').run(uuid)
    await sceneOutput()
    const newest = await sceneOutput()
    expect(newest.filePath).toBe(join(scenesRoot(), uuid, 'a_2.png'))
    hideImages(getDb(), [newest.id], 'scene')
    rmSync(newest.filePath)
    expect((await sceneOutput()).filePath).toBe(join(scenesRoot(), uuid, 'a_3.png'))
  })

  it('never writes outside the scenes root for a folder_uuid that is not one segment', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const folderUuid of ['../escape', '..', 'a/b', 'C:', join(root, 'abs')]) {
      getDb().prepare('UPDATE gen_scenes SET folder_uuid = ? WHERE id = 1').run(folderUuid)
      expect(sceneWriteDir(sceneFolderInfo(1)!)).toBe(join(scenesRoot(), 'p', 'a'))
    }
    expect((await sceneOutput()).filePath).toBe(join(scenesRoot(), 'p', 'a', 'a.png'))
    warn.mockRestore()
  })

  it('still recovers an output that crashed between the file write and the row commit', async () => {
    await trashedNewest()
    // 디코드할 수 없는 출력 — 파일은 쓰이고 썸네일에서 실패해 행·등록이 커밋되지 않는다
    const broken = Buffer.from('not an image')
    await expect(sceneOutput(broken)).rejects.toThrow()
    const db = getDb()
    const [intent] = db.prepare('SELECT seq, rel_path FROM media_intents').all() as {
      seq: number
      rel_path: string
    }[]
    expect(intent.rel_path).toBe('p/a/a_3.png')
    expect(existsSync(join(scenesRoot(), 'p', 'a', 'a_3.png'))).toBe(true)

    expect(await recoverPendingOutputs()).toEqual({ recovered: 1, dropped: 0, kept: 0 })
    expect(registrations().at(-1)).toMatchObject({ seq: intent.seq, rel_path: 'p/a/a_3.png' })
    expect(
      db
        .prepare('SELECT seq FROM images WHERE file_path = ?')
        .pluck()
        .all(join(scenesRoot(), 'p', 'a', 'a_3.png'))
    ).toEqual([intent.seq])
  })
})

describe('reclaiming unregistered outputs', () => {
  it('registers old rows by location, keeping their seq and hidden state, and can run again', () => {
    syncMediaRoots()
    const db = getDb()
    const current = join(imagesRoot(), '2025-01', 'current.png')
    const pastMain = join(root, 'old-out', '2024-05', 'main.png')
    const pastScene = join(root, 'old-scenes', 'preset', 'a', 'a_2.png')
    const a = insertImage(current)
    const b = insertImage(pastMain)
    const c = insertImage(pastScene, { scene: 1 })
    const dup = insertImage(pastMain)
    insertImage('memory://x.png')
    hideImages(db, [b], 'history')
    hideImages(db, [c], 'scene')
    const hiddenBefore = db.prepare('SELECT seq, scope FROM media_hidden ORDER BY seq').all()
    const seq = (id: number): number =>
      db.prepare('SELECT seq FROM images WHERE id = ?').pluck().get(id) as number

    const first = reclaimUnregistered(db)
    expect(first.registered).toBe(3)
    // 같은 파일을 가리키는 행은 합치지 않고 보고만 한다 — 먼저 등록된 쪽의 순번을 따른다
    expect(first.duplicates).toEqual([
      { imageId: dup, seq: seq(dup), filePath: pastMain, registeredSeq: seq(b) }
    ])

    const pastOut = roots().find((r) => r.path === join(root, 'old-out'))!
    const pastSceneRoot = roots().find((r) => r.path === join(root, 'old-scenes', 'preset', 'a'))!
    expect(pastOut).toMatchObject({ kind: 'output', status: 'past' })
    expect(pastSceneRoot).toMatchObject({ kind: 'scene', status: 'past' })
    expect(registrations()).toEqual([
      {
        seq: seq(a),
        root_id: 1,
        rel_path: '2025-01/current.png',
        source: 'reclaim',
        scene_id: null
      },
      {
        seq: seq(b),
        root_id: pastOut.id,
        rel_path: '2024-05/main.png',
        source: 'reclaim',
        scene_id: null
      },
      {
        seq: seq(c),
        root_id: pastSceneRoot.id,
        rel_path: 'a_2.png',
        source: 'reclaim',
        scene_id: 1
      }
    ])
    expect(db.prepare('SELECT scene_id, root_id, rel_dir FROM scene_sources').all()).toEqual([
      { scene_id: 1, root_id: pastSceneRoot.id, rel_dir: '' }
    ])
    // 파일이 하나도 없어도(오프라인 루트) 등록되고, 행·숨김은 그대로다
    expect(existsSync(pastMain)).toBe(false)
    expect(db.prepare('SELECT seq, scope FROM media_hidden ORDER BY seq').all()).toEqual(
      hiddenBefore
    )
    expect(count('images')).toBe(5)
    expect(isUnderImagesRoot(pastMain)).toBe(true)

    // 다시 돌려도 새로 등록할 것이 없다. 옛 앱이 그 뒤에 넣은 행만 잡힌다
    expect(reclaimUnregistered(db).registered).toBe(0)
    const later = insertImage(join(root, 'old-out', '2024-06', 'later.png'), { seq: null })
    assignMissingSeqs(db)
    expect(reclaimUnregistered(db).registered).toBe(1)
    expect(registrations().at(-1)).toMatchObject({
      seq: seq(later),
      root_id: pastOut.id,
      rel_path: '2024-06/later.png'
    })
    expect(roots()).toHaveLength(4)
  })

  it('keeps next_seq above every registered seq', () => {
    const db = getDb()
    syncMediaRoots()
    registerMedia(db, { rootId: 1, relPath: 'a.png', seq: 100, source: 'manual' })
    insertImage(join(imagesRoot(), 'b.png'), { seq: null })
    assignMissingSeqs(db)
    expect(db.prepare('SELECT seq FROM images').pluck().get()).toBe(101)
  })
})

describe('recovering outputs saved without a registration', () => {
  /** 의도를 남기고 파일을 썼는데 행·등록을 커밋하기 전에 앱이 죽은 상태 (반환: 파일, 잡아 둔 순번) */
  async function savedWithoutRegistration(name: string): Promise<{ path: string; seq: number }> {
    const ids = syncMediaRoots()
    const path = join(imagesRoot(), name)
    const { seq } = recordIntent(getDb(), {
      rootId: ids.output,
      relPath: name,
      kind: 't2i',
      seed: 42
    })
    mkdirSync(imagesRoot(), { recursive: true })
    const meta = buildNaisMetadata({
      sentPayload: JSON.stringify({ input: 'a cat', model: 'nai-diffusion-4-5-full' }),
      kind: 't2i',
      seed: 42,
      createdAt: new Date(),
      appVersion: '0',
      localMetadata: { promptParts: { base: 'a cat' } } as never
    })
    writeFileSync(path, embedNaisMetadata(await png(), meta))
    return { path, seq }
  }

  it('registers the file with the seq its intent reserved, without moving it', async () => {
    const db = getDb()
    insertImage(join(imagesRoot(), 'older.png'))
    const { path, seq } = await savedWithoutRegistration('crashed.png')

    expect(await recoverPendingOutputs()).toEqual({ recovered: 1, dropped: 0, kept: 0 })
    const row = db
      .prepare('SELECT seq, kind, seed, payload_json, thumbnail FROM images WHERE file_path = ?')
      .get(path) as {
      seq: number
      kind: string
      seed: number
      payload_json: string
      thumbnail: Buffer
    }
    expect(row).toMatchObject({ seq, kind: 't2i', seed: 42 })
    expect(JSON.parse(row.payload_json)).toMatchObject({
      input: 'a cat',
      nais3: { promptParts: { base: 'a cat' } }
    })
    expect(row.thumbnail.length).toBeGreaterThan(0)
    expect(registrations().at(-1)).toEqual({
      seq,
      root_id: 1,
      rel_path: 'crashed.png',
      source: 'generated',
      scene_id: null
    })
    expect(listImages(10, 0).items[0].filePath).toBe(path)
    expect(count('media_intents')).toBe(0)
    expect(await recoverPendingOutputs()).toEqual({ recovered: 0, dropped: 0, kept: 0 })
  })

  it('stays hidden when history was cleared after the intent and before the crash', async () => {
    const db = getDb()
    const { path, seq } = await savedWithoutRegistration('crashed.png')
    clearHistory(db)
    const cleared = db.prepare('SELECT cleared_seq FROM history_state').pluck().get() as number
    expect(seq).toBeLessThanOrEqual(cleared)

    expect(await recoverPendingOutputs()).toEqual({ recovered: 1, dropped: 0, kept: 0 })
    // 경계는 그대로, 되살린 출력은 경계 아래 — 비운 히스토리에 다시 나타나지 않는다
    expect(db.prepare('SELECT cleared_seq FROM history_state').pluck().get()).toBe(cleared)
    expect(db.prepare('SELECT seq FROM images WHERE file_path = ?').pluck().get(path)).toBe(seq)
    expect(registrations().map((r) => r.seq)).toEqual([seq])
    expect(listImages(10, 0)).toEqual({ total: 0, items: [] })

    // 비운 뒤의 출력은 그대로 보인다
    const after = await saveGeneratedImage({
      png: await png(),
      sentPayload: '{}',
      seed: 9,
      kind: 't2i'
    })
    expect(listImages(10, 0).items.map((i) => i.id)).toEqual([after.id])
  })

  it('drops intents whose file was never written, and keeps those on an offline root', async () => {
    const ids = syncMediaRoots()
    const db = getDb()
    mkdirSync(imagesRoot(), { recursive: true })
    recordIntent(db, { rootId: ids.output, relPath: 'never.png', kind: 't2i', seed: 1 })
    const offline = join(root, 'unplugged-drive')
    const offlineRoot = db
      .prepare(
        `INSERT INTO media_roots (kind, path, path_key, status) VALUES ('output', ?, ?, 'past') RETURNING id`
      )
      .pluck()
      .get(offline, offline) as number
    recordIntent(db, { rootId: offlineRoot, relPath: 'a.png', kind: 't2i', seed: 1 })

    expect(await recoverPendingOutputs()).toEqual({ recovered: 0, dropped: 1, kept: 1 })
    expect(db.prepare('SELECT rel_path FROM media_intents').pluck().all()).toEqual(['a.png'])
    expect(count('images')).toBe(0)
    expect(readdirSync(imagesRoot())).toEqual([])
  })

  it('drops an intent whose output is already registered with its seq', async () => {
    const { path, seq } = await savedWithoutRegistration('done.png')
    const db = getDb()
    const id = insertImage(path, { seq })
    expect(reclaimUnregistered(db).registered).toBe(1)
    expect(await recoverPendingOutputs()).toEqual({ recovered: 0, dropped: 1, kept: 0 })
    expect(db.prepare('SELECT id FROM images').pluck().all()).toEqual([id])
  })

  it('never adopts an older registration at the same location as the new output', async () => {
    const db = getDb()
    const ids = syncMediaRoots()
    // 예전 출력이 같은 위치로 등록돼 있다 (휴지통으로 보내 파일은 없다)
    const older = registerMedia(db, {
      rootId: ids.output,
      relPath: 'reused.png',
      seq: allocateSeq(db),
      source: 'generated'
    }).seq
    const { seq } = await savedWithoutRegistration('reused.png')
    expect(seq).not.toBe(older)

    expect(await recoverPendingOutputs()).toEqual({ recovered: 0, dropped: 0, kept: 1 })
    // 옛 순번을 새 출력의 것으로 쓰지 않고, 의도를 지우지도 않는다
    expect(registrations().map((r) => r.seq)).toEqual([older])
    expect(db.prepare('SELECT seq FROM media_intents').pluck().all()).toEqual([seq])
    expect(count('images')).toBe(0)
  })
})
