import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ db: null as Database.Database | null, saveDir: '', root: '' }))
vi.mock('../src/main/db', () => ({ getDb: () => mocks.db }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => (key === 'save_dir' ? mocks.saveDir : null),
  setSetting: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: (key: string) => join(mocks.root, key) } }))
import { restoreBackupDatabase } from '../src/main/backup/repo'
import { isUnderImagesRoot, libraryRoot } from '../src/main/images/storage'
it('restored curated images stay accessible after save directory changes', () => {
  mocks.root = mkdtempSync(join(tmpdir(), 'nais-review-path-'))
  mocks.saveDir = join(mocks.root, 'custom-output-A')
  mocks.db = new Database(':memory:')
  mocks.db.exec('CREATE TABLE library_images (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL)')
  try {
    restoreBackupDatabase({
      version: 1,
      includedTables: ['library_images'],
      tables: { library_images: [{ id: 1, file_path: '' }] },
      mainParams: null,
      files: [
        {
          table: 'library_images',
          rowId: 1,
          column: 'file_path',
          extension: '.png',
          data: Buffer.from('image')
        }
      ]
    })
    const restored = mocks.db
      .prepare('SELECT file_path FROM library_images')
      .pluck()
      .get() as string
    expect(isUnderImagesRoot(restored)).toBe(true)
    mocks.saveDir = join(mocks.root, 'custom-output-B')
    expect(isUnderImagesRoot(restored)).toBe(true)
    expect(isUnderImagesRoot(join(libraryRoot(), 'curated', 'normal.png'))).toBe(true)
  } finally {
    mocks.db.close()
    rmSync(mocks.root, { recursive: true, force: true })
  }
})
