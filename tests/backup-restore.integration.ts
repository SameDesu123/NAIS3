import Database from 'better-sqlite3'
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  libraryRoot: vi.fn(),
  defaultImagesRoot: vi.fn(),
  getSetting: vi.fn()
}))

vi.mock('../src/main/db', () => ({ getDb: mocks.getDb }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: mocks.getSetting,
  setSetting: (key: string, value: string) => {
    mocks
      .getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value)
  }
}))
vi.mock('../src/main/images/storage', () => ({
  libraryRoot: mocks.libraryRoot,
  defaultImagesRoot: mocks.defaultImagesRoot
}))

import { createNaisArchive, readNaisArchive } from '../src/main/backup/archive'
import { legacyNais3ToBackupDatabase } from '../src/main/backup/legacy'
import {
  captureBackupDatabase,
  exportLegacyJson,
  restoreBackupDatabase
} from '../src/main/backup/repo'
import type { BackupDatabase } from '../src/main/backup/types'
import { ensureSteps } from '../src/main/db/ensure'
import { migrations } from '../src/main/db/migrations'

let db: Database.Database
let imageRoot: string

function databaseFixture(duplicateNames = false): BackupDatabase {
  const images = [
    {
      id: 11,
      name: 'new-image',
      file_path: '',
      thumbnail: Buffer.from('thumb'),
      width: 100,
      height: 200,
      stack_id: 10,
      created_at: '2026-08-24',
      sort_order: 1
    }
  ]
  if (duplicateNames) images.push({ ...images[0], id: 12 })

  return {
    version: 2,
    includedTables: ['library_stacks', 'library_images'],
    tables: {
      library_stacks: [{ id: 10, name: 'new-stack', created_at: '2026-08-24' }],
      library_images: images
    },
    mainParams: '{"prompt":"restored"}',
    files: images.map((row) => ({
      table: 'library_images' as const,
      rowId: row.id,
      column: 'file_path' as const,
      extension: '.webp',
      data: Buffer.from(`image-${row.id}`)
    })),
    missingFiles: []
  }
}

/** The app's schema: numbered migrations, then ensure.ts unless `ensure` is false (1.0.29). */
function migratedDatabase(ensure = true): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  for (const migration of migrations) migration(database)
  if (ensure) for (const step of ensureSteps) step.apply(database)
  return database
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE library_stacks (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE library_images (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      thumbnail BLOB,
      width INTEGER,
      height INTEGER,
      stack_id INTEGER,
      created_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    INSERT INTO library_stacks VALUES (1, 'old-stack', '2026-08-23');
    INSERT INTO library_images VALUES (2, 'old-image', '/old.png', NULL, 1, 1, 1, '2026-08-23', 1);
  `)
  imageRoot = mkdtempSync(join(tmpdir(), 'nais-backup-restore-'))
  mocks.getDb.mockReturnValue(db)
  mocks.libraryRoot.mockReturnValue(imageRoot)
  mocks.defaultImagesRoot.mockReturnValue(join(imageRoot, 'images'))
  mocks.getSetting.mockReturnValue(null)
})

afterEach(() => {
  db.close()
  rmSync(imageRoot, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('backup database restore', () => {
  it('replaces declared tables and writes archive assets to new local paths', () => {
    const result = restoreBackupDatabase(databaseFixture())

    expect(result).toEqual({ imported: 2, missingFiles: 0 })
    expect(db.prepare('SELECT name FROM library_stacks').pluck().all()).toEqual(['new-stack'])
    const image = db.prepare('SELECT name, file_path, thumbnail FROM library_images').get() as {
      name: string
      file_path: string
      thumbnail: Buffer
    }
    expect(image.name).toBe('new-image')
    expect(image.file_path).toContain(join('_imported', ''))
    expect(readFileSync(image.file_path)).toEqual(Buffer.from('image-11'))
    expect(image.thumbnail).toEqual(Buffer.from('thumb'))
    expect(db.prepare("SELECT value FROM settings WHERE key = 'main_params'").pluck().get()).toBe(
      '{"prompt":"restored"}'
    )
  })

  it('rolls back the database and removes staged files when insertion fails', () => {
    expect(() => restoreBackupDatabase(databaseFixture(true))).toThrow('UNIQUE constraint failed')

    expect(db.prepare('SELECT name FROM library_stacks').pluck().all()).toEqual(['old-stack'])
    expect(db.prepare('SELECT name FROM library_images').pluck().all()).toEqual(['old-image'])
    const importedRoot = join(imageRoot, '_imported')
    expect(existsSync(importedRoot) ? readdirSync(importedRoot) : []).toEqual([])
  })

  it('restores a row listed as missing with an empty file path and no file', () => {
    const database = databaseFixture()
    database.files = []
    database.missingFiles = [{ table: 'library_images', rowId: 11, column: 'file_path' }]

    expect(restoreBackupDatabase(database)).toEqual({ imported: 2, missingFiles: 1 })
    const image = db.prepare('SELECT file_path, thumbnail FROM library_images').get() as {
      file_path: string
      thumbnail: Buffer
    }
    expect(image).toEqual({ file_path: '', thumbnail: Buffer.from('thumb') })
    expect(existsSync(join(imageRoot, '_imported'))).toBe(false)
  })

  it('still refuses a file-backed row with neither a file nor a missing entry', () => {
    const database = databaseFixture()
    database.files = []

    expect(() => restoreBackupDatabase(database)).toThrow(
      'Backup is missing the file for library_images row 11'
    )
    expect(db.prepare('SELECT name FROM library_images').pluck().all()).toEqual(['old-image'])
  })
})

describe('.nais export of rows with missing files', () => {
  it('keeps the row, its thumbnail and paid vibe encoding through export and restore', async () => {
    const source = migratedDatabase()
    const existing = join(imageRoot, 'present.png')
    writeFileSync(existing, 'present image')
    source
      .prepare(
        `INSERT INTO vibe_images (id, name, file_path, thumbnail, encoded, encoded_ie)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(1, 'present', existing, Buffer.from('thumb-1'), null, null)
    source
      .prepare(
        `INSERT INTO vibe_images (id, name, file_path, thumbnail, encoded, encoded_ie)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(2, 'gone', join(imageRoot, 'deleted.png'), Buffer.from('thumb-2'), 'paid', 0.7)
    mocks.getDb.mockReturnValue(source)

    const captured = captureBackupDatabase()
    expect(captured.missingFiles).toEqual([{ table: 'vibe_images', rowId: 2, column: 'file_path' }])
    const archive = await createNaisArchive(captured, '1.0.30')
    source.close()

    const target = migratedDatabase()
    mocks.getDb.mockReturnValue(target)
    try {
      const result = restoreBackupDatabase(await readNaisArchive(archive))
      expect(result.missingFiles).toBe(1)
      const rows = target
        .prepare(
          'SELECT id, file_path, thumbnail, encoded, encoded_ie FROM vibe_images ORDER BY id'
        )
        .all() as { id: number; file_path: string; thumbnail: Buffer; encoded: string | null }[]
      expect(rows).toHaveLength(2)
      expect(readFileSync(rows[0].file_path)).toEqual(Buffer.from('present image'))
      expect(rows[1]).toEqual({
        id: 2,
        file_path: '',
        thumbnail: Buffer.from('thumb-2'),
        encoded: 'paid',
        encoded_ie: 0.7
      })
    } finally {
      target.close()
    }
  })
})

describe('media ledger and scene folders across a restore', () => {
  function seedWorkspace(): Database.Database {
    const database = migratedDatabase()
    database.exec(`
      INSERT INTO gen_scenes (id, name, folder_uuid) VALUES (1, 'local scene', 'uuid-local');
      INSERT INTO media_roots (id, kind, path, path_key) VALUES (1, 'scene', '/scenes', '/scenes');
      INSERT INTO scene_sources (scene_id, root_id, rel_dir, dir_key, role)
        VALUES (1, 1, 'uuid-local', 'uuid-local', 'write');
      INSERT INTO media_registrations (seq, root_id, rel_path, path_key, source, scene_id)
        VALUES (1, 1, 'uuid-local/local scene_1.png', 'uuid-local/local scene_1.png', 'generated', 1);
      INSERT INTO media_hidden (seq, scope) VALUES (1, 'history');
      UPDATE history_state SET next_seq = 2, cleared_seq = 1;
    `)
    return database
  }

  function scenesArchive(scenes: Record<string, string | number | null>[]): BackupDatabase {
    return {
      version: 2,
      includedTables: ['gen_scenes'],
      tables: { gen_scenes: scenes },
      mainParams: null,
      files: [],
      missingFiles: []
    }
  }

  it('leaves the ledger alone and drops only links to the replaced scenes', () => {
    const target = seedWorkspace()
    mocks.getDb.mockReturnValue(target)
    try {
      restoreBackupDatabase(
        scenesArchive([{ id: 1, name: 'restored scene', folder_uuid: 'uuid-restored' }])
      )

      expect(target.prepare('SELECT id, name, folder_uuid FROM gen_scenes').all()).toEqual([
        { id: 1, name: 'restored scene', folder_uuid: 'uuid-restored' }
      ])
      // Same id, different scene: nothing may still point at it
      expect(target.prepare('SELECT COUNT(*) FROM scene_sources').pluck().get()).toBe(0)
      expect(target.prepare('SELECT seq, scene_id FROM media_registrations').all()).toEqual([
        { seq: 1, scene_id: null }
      ])
      expect(target.prepare('SELECT COUNT(*) FROM media_roots').pluck().get()).toBe(1)
      expect(target.prepare('SELECT seq, scope FROM media_hidden').all()).toEqual([
        { seq: 1, scope: 'history' }
      ])
      expect(target.prepare('SELECT next_seq, cleared_seq FROM history_state').get()).toEqual({
        next_seq: 2,
        cleared_seq: 1
      })
    } finally {
      target.close()
    }
  })

  it('carries folder_uuid in .nais and restores archives from before it as NULL', async () => {
    const source = seedWorkspace()
    mocks.getDb.mockReturnValue(source)
    const archive = await createNaisArchive(captureBackupDatabase(), '1.0.30')
    source.close()

    const target = migratedDatabase()
    mocks.getDb.mockReturnValue(target)
    try {
      restoreBackupDatabase(await readNaisArchive(archive))
      expect(target.prepare('SELECT folder_uuid FROM gen_scenes').pluck().all()).toEqual([
        'uuid-local'
      ])
      restoreBackupDatabase({ ...scenesArchive([{ id: 1, name: 'v1 scene' }]), version: 1 })
      expect(target.prepare('SELECT folder_uuid FROM gen_scenes').pluck().all()).toEqual([null])
    } finally {
      target.close()
    }
  })

  it('restores scene links on the same device and changes nothing else', async () => {
    const source = seedWorkspace()
    mocks.getDb.mockReturnValue(source)
    try {
      const archive = await createNaisArchive(captureBackupDatabase(), '1.0.30')
      restoreBackupDatabase(await readNaisArchive(archive))

      expect(source.prepare('SELECT id, path, status FROM media_roots').all()).toEqual([
        { id: 1, path: '/scenes', status: 'current' }
      ])
      expect(
        source.prepare('SELECT seq, root_id, scene_id FROM media_registrations').all()
      ).toEqual([{ seq: 1, root_id: 1, scene_id: 1 }])
      expect(source.prepare('SELECT scene_id, rel_dir, role FROM scene_sources').all()).toEqual([
        { scene_id: 1, rel_dir: 'uuid-local', role: 'write' }
      ])
      expect(source.prepare('SELECT seq, scope FROM media_hidden').all()).toEqual([
        { seq: 1, scope: 'history' }
      ])
      expect(source.prepare('SELECT next_seq, cleared_seq FROM history_state').get()).toEqual({
        next_seq: 2,
        cleared_seq: 1
      })
    } finally {
      source.close()
    }
  })

  it('merges the ledger on another device: unmapped roots, fresh seqs, hides carried over', async () => {
    const source = seedWorkspace()
    source.exec(`
      INSERT INTO media_registrations (seq, root_id, rel_path, path_key, source, scene_id)
        VALUES (2, 1, 'uuid-local/local scene_2.png', 'uuid-local/local scene_2.png', 'generated', 1);
      INSERT INTO media_hidden (seq, scope) VALUES (2, 'scene');
      UPDATE history_state SET next_seq = 3;
    `)
    mocks.getDb.mockReturnValue(source)
    const archive = await createNaisArchive(captureBackupDatabase(), '1.0.30')
    source.close()

    const target = migratedDatabase()
    target.exec(`
      INSERT INTO media_roots (id, kind, path, path_key) VALUES (1, 'output', '/here', '/here');
      INSERT INTO media_registrations (seq, root_id, rel_path, path_key, source)
        VALUES (40, 1, 'mine.png', 'mine.png', 'generated');
      UPDATE history_state SET next_seq = 41, cleared_seq = 5;
    `)
    mocks.getDb.mockReturnValue(target)
    try {
      restoreBackupDatabase(await readNaisArchive(archive))

      expect(target.prepare('SELECT id, kind, path, status FROM media_roots').all()).toEqual([
        { id: 1, kind: 'output', path: '/here', status: 'current' },
        { id: 2, kind: 'scene', path: '/scenes', status: 'unmapped' }
      ])
      expect(
        target
          .prepare('SELECT seq, root_id, rel_path, scene_id FROM media_registrations ORDER BY seq')
          .all()
      ).toEqual([
        { seq: 40, root_id: 1, rel_path: 'mine.png', scene_id: null },
        { seq: 41, root_id: 2, rel_path: 'uuid-local/local scene_1.png', scene_id: 1 },
        { seq: 42, root_id: 2, rel_path: 'uuid-local/local scene_2.png', scene_id: 1 }
      ])
      // 41은 아카이브에서 비운 히스토리 아래였다 — 새 순번이라 숨겨야 다시 나타나지 않는다
      expect(
        target.prepare('SELECT seq, scope FROM media_hidden ORDER BY seq, scope').all()
      ).toEqual([
        { seq: 41, scope: 'history' },
        { seq: 42, scope: 'scene' }
      ])
      expect(
        target.prepare('SELECT scene_id, root_id, rel_dir, role FROM scene_sources').all()
      ).toEqual([{ scene_id: 1, root_id: 2, rel_dir: 'uuid-local', role: 'write' }])
      // 비우기 경계는 이 기기 그대로, next_seq는 앞으로만
      expect(target.prepare('SELECT next_seq, cleared_seq FROM history_state').get()).toEqual({
        next_seq: 43,
        cleared_seq: 5
      })
    } finally {
      target.close()
    }
  })

  it('carries external copies and writes them to the import folder without overwriting', async () => {
    const sourceRoot = join(imageRoot, 'source-imports')
    mkdirSync(join(sourceRoot, '2026-10'), { recursive: true })
    writeFileSync(join(sourceRoot, '2026-10', 'photo.png'), 'photo bytes')
    const source = migratedDatabase()
    source
      .prepare(`INSERT INTO media_roots (id, kind, path, path_key) VALUES (1, 'external', ?, ?)`)
      .run(sourceRoot, sourceRoot)
    source.exec(`
      INSERT INTO media_registrations (seq, root_id, rel_path, path_key, source)
        VALUES (1, 1, '2026-10/photo.png', '2026-10/photo.png', 'external'),
               (2, 1, '2026-10/gone.png', '2026-10/gone.png', 'external');
      UPDATE history_state SET next_seq = 3;
    `)
    mocks.getDb.mockReturnValue(source)
    const database = captureBackupDatabase()
    source.close()
    expect(database.ledgerFiles?.map((file) => file.seq)).toEqual([1])
    const archive = await createNaisArchive(database, '1.0.30')
    rmSync(sourceRoot, { recursive: true })

    const importRoot = join(imageRoot, 'images', 'NAIS3_imported')
    mkdirSync(join(importRoot, '2026-10'), { recursive: true })
    writeFileSync(join(importRoot, '2026-10', 'photo.png'), 'someone else')
    const target = migratedDatabase()
    mocks.getDb.mockReturnValue(target)
    try {
      restoreBackupDatabase(await readNaisArchive(archive))

      expect(readFileSync(join(importRoot, '2026-10', 'photo.png'), 'utf8')).toBe('someone else')
      expect(readFileSync(join(importRoot, '2026-10', 'photo_2.png'), 'utf8')).toBe('photo bytes')
      expect(target.prepare('SELECT id, kind, path, status FROM media_roots').all()).toEqual([
        { id: 1, kind: 'external', path: importRoot, status: 'current' },
        { id: 2, kind: 'external', path: sourceRoot, status: 'unmapped' }
      ])
      expect(
        target
          .prepare('SELECT root_id, rel_path, source FROM media_registrations ORDER BY seq')
          .all()
      ).toEqual([
        { root_id: 1, rel_path: '2026-10/photo_2.png', source: 'external' },
        // 파일이 없던 등록은 아카이브의 루트(unmapped)에 남는다
        { root_id: 2, rel_path: '2026-10/gone.png', source: 'external' }
      ])

      // 같은 아카이브를 다시 복원해도 복사본을 또 쓰지 않는다
      restoreBackupDatabase(await readNaisArchive(archive))
      expect(readdirSync(join(importRoot, '2026-10')).sort()).toEqual(['photo.png', 'photo_2.png'])
      expect(target.prepare('SELECT COUNT(*) FROM media_registrations').pluck().get()).toBe(2)
    } finally {
      target.close()
    }
  })

  /** 복사본 폴더(이 기기의 import 루트)에 있는 외부 이미지 하나를 담은 아카이브 */
  async function importRootArchive(importRoot: string): Promise<Buffer> {
    mkdirSync(join(importRoot, '2026-10'), { recursive: true })
    writeFileSync(join(importRoot, '2026-10', 'photo.png'), 'photo bytes')
    const source = migratedDatabase()
    source
      .prepare(`INSERT INTO media_roots (id, kind, path, path_key) VALUES (1, 'external', ?, ?)`)
      .run(importRoot, importRoot)
    source.exec(`
      INSERT INTO media_registrations (seq, root_id, rel_path, path_key, source)
        VALUES (1, 1, '2026-10/photo.png', '2026-10/photo.png', 'external');
      UPDATE history_state SET next_seq = 2;
    `)
    mocks.getDb.mockReturnValue(source)
    const database = captureBackupDatabase()
    source.close()
    return createNaisArchive(database, '1.0.30')
  }

  it('writes an external copy back into an empty database with the same import path', async () => {
    const importRoot = join(imageRoot, 'images', 'NAIS3_imported')
    const archive = await importRootArchive(importRoot)
    // 새 기기(같은 사용자 경로) — 파일이 없다
    rmSync(importRoot, { recursive: true })
    const target = migratedDatabase()
    mocks.getDb.mockReturnValue(target)
    try {
      restoreBackupDatabase(await readNaisArchive(archive))
      expect(readFileSync(join(importRoot, '2026-10', 'photo.png'), 'utf8')).toBe('photo bytes')
      expect(
        target.prepare('SELECT root_id, rel_path FROM media_registrations').all()
      ).toEqual([{ root_id: 1, rel_path: '2026-10/photo.png' }])
    } finally {
      target.close()
    }
  })

  it('writes a deleted external copy back on the same device without a new registration', async () => {
    const importRoot = join(imageRoot, 'images', 'NAIS3_imported')
    const archive = await importRootArchive(importRoot)
    const target = migratedDatabase()
    mocks.getDb.mockReturnValue(target)
    try {
      restoreBackupDatabase(await readNaisArchive(archive))
      // 파일이 그대로 있으면 쓰지 않는다
      expect(readdirSync(join(importRoot, '2026-10'))).toEqual(['photo.png'])
      const seq = target.prepare('SELECT seq FROM media_registrations').pluck().get()

      rmSync(join(importRoot, '2026-10', 'photo.png'))
      restoreBackupDatabase(await readNaisArchive(archive))
      expect(readFileSync(join(importRoot, '2026-10', 'photo.png'), 'utf8')).toBe('photo bytes')
      // 같은 위치라 이 기기의 순번을 그대로 쓴다
      expect(
        target.prepare('SELECT seq, root_id, rel_path FROM media_registrations').all()
      ).toEqual([{ seq, root_id: 1, rel_path: '2026-10/photo.png' }])

      // 다른 내용으로 바뀐 파일은 덮어쓰지 않고 _2에 쓴다
      writeFileSync(join(importRoot, '2026-10', 'photo.png'), 'edited')
      restoreBackupDatabase(await readNaisArchive(archive))
      expect(readFileSync(join(importRoot, '2026-10', 'photo.png'), 'utf8')).toBe('edited')
      expect(readFileSync(join(importRoot, '2026-10', 'photo_2.png'), 'utf8')).toBe('photo bytes')
    } finally {
      target.close()
    }
  })

  it('keeps the legacy JSON export importable by a schema without ensure columns', () => {
    const source = seedWorkspace()
    mocks.getDb.mockReturnValue(source)
    const legacy = exportLegacyJson()
    source.close()
    const scenes = (legacy.tables as Record<string, Record<string, unknown>[]>).gen_scenes
    expect(scenes[0]).not.toHaveProperty('folder_uuid')

    const old = migratedDatabase(false)
    mocks.getDb.mockReturnValue(old)
    try {
      restoreBackupDatabase(legacyNais3ToBackupDatabase(legacy))
      expect(old.prepare('SELECT name FROM gen_scenes').pluck().all()).toEqual(['local scene'])
    } finally {
      old.close()
    }
  })
})
