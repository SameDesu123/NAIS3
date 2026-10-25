import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  libraryRoot: vi.fn(),
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
vi.mock('../src/main/images/storage', () => ({ libraryRoot: mocks.libraryRoot }))

import { createNaisArchive, readNaisArchive } from '../src/main/backup/archive'
import { captureBackupDatabase, restoreBackupDatabase } from '../src/main/backup/repo'
import type { BackupDatabase } from '../src/main/backup/types'
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

function migratedDatabase(): Database.Database {
  const database = new Database(':memory:')
  for (const migration of migrations) migration(database)
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
