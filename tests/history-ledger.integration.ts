import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { shell } from 'electron'
// The app's sharp, not 'sharp' itself (see thumbnail-cache.integration.ts)
import sharp from '../src/main/sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import {
  allocateSeq,
  clearHistory,
  HISTORY_PAGE_SQL,
  historyCount,
  historyParams,
  historySeqs
} from '../src/main/db/history'
import {
  registerFoundFiles,
  registerMedia,
  syncExternalRoot,
  type RegistrationSource
} from '../src/main/db/media'
import { setSetting } from '../src/main/db/settings'
import {
  defaultImagesRoot,
  getImagePayload,
  imagesRoot,
  listImages,
  saveGeneratedImage,
  syncMediaRoots,
  thumbnailForUrl
} from '../src/main/images/storage'
import { deleteImage, sceneImages, setImageFavorite } from '../src/main/scenes/repo'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'en-US', getVersion: () => '0' },
  BrowserWindow: {},
  dialog: {},
  shell: { trashItem: vi.fn(async () => undefined) },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let root: string

function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: '#2050d0' } })
    .png()
    .toBuffer()
}

async function writePng(path: string): Promise<string> {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, await png())
  return path
}

function insertRoot(path: string, status: 'current' | 'past' | 'unmapped'): number {
  return getDb()
    .prepare(
      `INSERT INTO media_roots (kind, path, path_key, status) VALUES ('output', ?, ?, ?) RETURNING id`
    )
    .pluck()
    .get(path, path, status) as number
}

function register(rootId: number, relPath: string, source: RegistrationSource = 'reindex'): number {
  const db = getDb()
  return registerMedia(db, { rootId, relPath, seq: allocateSeq(db), source }).seq
}

const hidden = (seq: number): string[] =>
  getDb()
    .prepare('SELECT scope FROM media_hidden WHERE seq = ? ORDER BY scope')
    .pluck()
    .all(seq) as string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-history-ledger-'))
  environment.directory = root
  initDb()
  vi.mocked(shell.trashItem).mockClear()
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('history from the ledger', () => {
  it('lists generated, reindexed and external registrations by seq', async () => {
    const db = getDb()
    const generated = await saveGeneratedImage({
      png: await png(),
      sentPayload: '{"x":1}',
      seed: 7,
      kind: 't2i'
    })
    // 재색인: images 행 없이 원장에만
    const found = await writePng(join(imagesRoot(), 'old', 'found.png'))
    expect(registerFoundFiles(db, [found])).toBe(1)
    // 복원해 온 외부 복사본: 외부 루트의 원장 등록만
    const importedDir = join(defaultImagesRoot(), 'NAIS3_imported', '2026-01')
    const imported = await writePng(join(importedDir, 'photo.png'))
    const externalRoot = syncExternalRoot(db, join(defaultImagesRoot(), 'NAIS3_imported'))
    const importedSeq = register(externalRoot, '2026-01/photo.png', 'external')

    const { items, total } = listImages(10, 0)
    expect(total).toBe(3)
    expect(items.map((i) => [i.filePath, i.kind, i.seed])).toEqual([
      [imported, 'external', null],
      [found, 'external', null],
      [generated.filePath, 't2i', 7]
    ])
    expect(items[0].id).toBe(importedSeq)
    expect(items.every((i) => !i.missing)).toBe(true)
    // 원장에만 있는 항목도 썸네일이 파일에서 나온다
    const thumb = await thumbnailForUrl(new URL(items[1].thumbnailUrl))
    expect(thumb?.length).toBeGreaterThan(0)
    // payload는 images 행이 있는 항목만
    expect(getImagePayload(items[2].id)).toContain('"x":1')
    expect(getImagePayload(items[1].id)).toBeNull()
  })

  it('drops hidden and cleared entries, and counts what it shows', async () => {
    const db = getDb()
    syncMediaRoots()
    const a = await writePng(join(imagesRoot(), 'a.png'))
    const b = await writePng(join(imagesRoot(), 'b.png'))
    registerFoundFiles(db, [a, b])
    const [bSeq, aSeq] = listImages(10, 0).items.map((i) => i.id)

    const result = await deleteImage(aSeq, 'history')
    expect(result).toEqual({ mode: 'hide', results: [{ id: aSeq, ok: true }] })
    expect(hidden(aSeq)).toEqual(['history'])
    expect(listImages(10, 0)).toMatchObject({ total: 1, items: [{ id: bSeq }] })

    // 씬 scope 숨김은 히스토리에 상관없다
    await deleteImage(bSeq, 'scene')
    expect(listImages(10, 0).total).toBe(1)

    expect(clearHistory(db)).toBe(1)
    expect(listImages(10, 0)).toEqual({ items: [], total: 0 })
    const c = await writePng(join(imagesRoot(), 'c.png'))
    registerFoundFiles(db, [c])
    expect(listImages(10, 0)).toMatchObject({ total: 1, items: [{ filePath: c }] })
  })

  it('leaves out roots restored from another device, and marks offline files missing', async () => {
    const db = getDb()
    const unmapped = insertRoot(join(root, 'other-device'), 'unmapped')
    register(unmapped, 'gone.png')
    // 다른 기기 경로를 가리키는 복원된 images 행은 지금처럼 보인다 (행의 경로로)
    const restoredSeq = allocateSeq(db)
    db.prepare(
      `INSERT INTO images (file_path, thumbnail, kind, payload_json, seq)
       VALUES (?, x'01', 't2i', '{}', ?)`
    ).run('/other/device/restored.png', restoredSeq)
    registerMedia(db, {
      rootId: unmapped,
      relPath: 'restored.png',
      seq: restoredSeq,
      source: 'generated'
    })
    // 연결이 끊긴 예전 저장 폴더 — 항목은 남고 missing
    const offline = insertRoot(join(root, 'unplugged-drive'), 'past')
    const offlineSeq = register(offline, '2026-01/a.png')

    const { items, total } = listImages(10, 0)
    expect(total).toBe(2)
    expect(items.map((i) => [i.id, i.filePath, i.missing])).toEqual([
      [offlineSeq, join(root, 'unplugged-drive', '2026-01', 'a.png'), true],
      [restoredSeq, '/other/device/restored.png', true]
    ])
  })

  it('moves offline files out of history without trashing anything', async () => {
    setSetting('delete_to_trash', '1')
    const offline = insertRoot(join(root, 'unplugged-drive'), 'past')
    const seq = register(offline, 'a.png')
    const result = await deleteImage(seq, 'history')
    expect(result).toEqual({ mode: 'trash', results: [{ id: seq, ok: true }] })
    expect(shell.trashItem).not.toHaveBeenCalled()
    expect(hidden(seq)).toEqual(['history', 'scene'])
  })

  it('trashes a ledger-only file only when the trash setting is on', async () => {
    const db = getDb()
    syncMediaRoots()
    const file = await writePng(join(imagesRoot(), 'found.png'))
    registerFoundFiles(db, [file])
    const seq = listImages(1, 0).items[0].id
    setSetting('delete_to_trash', '1')
    await deleteImage(seq, 'scene')
    expect(shell.trashItem).toHaveBeenCalledWith(file)
    expect(hidden(seq)).toEqual(['history', 'scene'])
  })

  it('keys favorites, scene images and memory images by seq', async () => {
    const db = getDb()
    db.exec(`INSERT INTO gen_scenes (id, preset_id, name, sort_order) VALUES (1, 1, 'a', 0)`)
    // id와 seq가 어긋나게: 행을 먼저 넣고 순번은 나중에 크게
    for (let i = 0; i < 5; i++) allocateSeq(db)
    const seq = allocateSeq(db)
    const id = Number(
      db
        .prepare(
          `INSERT INTO images (file_path, thumbnail, kind, payload_json, scene_id, seq)
           VALUES ('/s/a.png', x'01', 'scene', '{}', 1, ?)`
        )
        .run(seq).lastInsertRowid
    )
    expect(id).not.toBe(seq)
    expect(sceneImages(1, 10, 0).items.map((i) => i.id)).toEqual([seq])
    expect(setImageFavorite(seq, true)).toBe(1)
    expect(db.prepare('SELECT favorite FROM images WHERE id = ?').pluck().get(id)).toBe(1)
    // 원장에만 있는 항목은 images.favorite가 없어 아직 바뀌지 않는다
    syncMediaRoots()
    const file = await writePng(join(imagesRoot(), 'found.png'))
    registerFoundFiles(db, [file])
    const ledgerOnly = listImages(1, 0).items[0].id
    expect(setImageFavorite(ledgerOnly, true)).toBeNull()

    // memory:// 는 지금처럼 행째 지운다
    const memorySeq = allocateSeq(db)
    db.prepare(
      `INSERT INTO images (file_path, thumbnail, kind, payload_json, seq)
       VALUES ('memory://x.png', x'01', 't2i', '{}', ?)`
    ).run(memorySeq)
    expect(await deleteImage(memorySeq, 'history')).toEqual({
      mode: 'hide',
      results: [{ id: memorySeq, ok: true }]
    })
    expect(db.prepare('SELECT COUNT(*) FROM images WHERE seq = ?').pluck().get(memorySeq)).toBe(0)
    expect(hidden(memorySeq)).toEqual([])
  })

  it('pages a few thousand entries consistently, by offset and by seq', () => {
    const db = getDb()
    const live = insertRoot(join(root, 'live'), 'current')
    const unmapped = insertRoot(join(root, 'elsewhere'), 'unmapped')
    const insertImage = db.prepare(
      `INSERT INTO images (file_path, kind, payload_json, seq) VALUES (?, 't2i', '{}', ?)`
    )
    const hide = db.prepare("INSERT INTO media_hidden (seq, scope) VALUES (?, 'history')")
    db.transaction(() => {
      for (let i = 0; i < 4000; i++) {
        const seq = allocateSeq(db)
        const kind = i % 5
        // 0: 원장만, 1: 행 + 등록, 2: 행만, 3: unmapped 등록만, 4: unmapped 등록 + 행
        if (kind !== 2) {
          registerMedia(db, {
            rootId: kind >= 3 ? unmapped : live,
            relPath: `${i}.png`,
            seq,
            source: 'generated'
          })
        }
        if (kind === 1 || kind === 2 || kind === 4) insertImage.run(`/x/${i}.png`, seq)
        if (i % 7 === 0) hide.run(seq)
      }
    })()
    db.prepare('UPDATE history_state SET cleared_seq = 100 WHERE id = 1').run()

    // 기대값: 같은 규칙을 순진하게
    const naive = db
      .prepare(
        `SELECT seq FROM (
           SELECT r.seq FROM media_registrations r JOIN media_roots ro ON ro.id = r.root_id
           WHERE ro.status != 'unmapped'
           UNION SELECT seq FROM images
         )
         WHERE seq > 100 AND seq NOT IN (SELECT seq FROM media_hidden WHERE scope = 'history')
         ORDER BY seq DESC`
      )
      .pluck()
      .all() as number[]
    expect(naive.length).toBeGreaterThan(2000)
    expect(historyCount(db)).toBe(naive.length)
    expect(listImages(1, 0).total).toBe(naive.length)

    const byOffset: number[] = []
    for (let offset = 0; offset < naive.length + 60; offset += 60)
      byOffset.push(...historySeqs(db, { limit: 60, offset }))
    expect(byOffset).toEqual(naive)

    const byCursor: number[] = []
    for (let before: number | undefined; ;) {
      const page = historySeqs(db, { limit: 60, before })
      if (page.length === 0) break
      byCursor.push(...page)
      before = page[page.length - 1]
    }
    expect(byCursor).toEqual(naive)
    expect(listImages(3, 0, naive[10]).items.map((i) => i.id)).toEqual(naive.slice(11, 14))

    // 두 쪽 모두 seq 순서로 읽는다 — 임시 B-tree 정렬이 없다
    const plan = (
      db
        .prepare(`EXPLAIN QUERY PLAN ${HISTORY_PAGE_SQL}`)
        .all({ ...historyParams(db), limit: 60, offset: 0 }) as { detail: string }[]
    ).map((r) => r.detail)
    expect(plan.join('\n')).toMatch(/MERGE \(UNION\)/)
    expect(plan.join('\n')).not.toMatch(/TEMP B-TREE/)
  })
})
