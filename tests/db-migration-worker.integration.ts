import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb, migrateInWorker, pendingMigration } from '../src/main/db'
import { migrations } from '../src/main/db/migrations'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory }
}))

let bundle: string
let root: string
const path = (): string => join(environment.directory, 'nais3.db')
const backups = (): string => join(environment.directory, 'backups')

// The app loads the worker from the electron-vite build; bundle the same entry for Node here.
beforeAll(async () => {
  bundle = mkdtempSync(join(tmpdir(), 'nais3-migration-worker-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: resolve('src/main/db/migrate.worker.ts'),
      outDir: bundle,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'migrate.worker.cjs',
          // Resolve the native module from the repository, not from the temporary bundle.
          paths: { 'better-sqlite3': createRequire(import.meta.url).resolve('better-sqlite3') }
        }
      }
    }
  })
  bundle = join(bundle, 'migrate.worker.cjs')
}, 60_000)

afterAll(() => {
  if (bundle) rmSync(join(bundle, '..'), { recursive: true, force: true })
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-migration-'))
  environment.directory = join(root, "workspace's data")
  mkdirSync(environment.directory)
})

afterEach(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

function seed(version: number, language?: string): void {
  const db = new Database(path())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (let v = 0; v < version; v++)
    db.transaction(() => {
      migrations[v](db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  db.prepare('INSERT INTO images (file_path, thumbnail, payload_json) VALUES (?, ?, ?)').run(
    '/fixture/generated.png',
    Buffer.from([1, 2, 3]),
    '{}'
  )
  if (language)
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ui_language', language)
  db.close()
}

function version(): number {
  const db = new Database(path(), { readonly: true, fileMustExist: true })
  try {
    return db.pragma('user_version', { simple: true }) as number
  } finally {
    db.close()
  }
}

describe('DB migration worker', () => {
  it('reports pending upgrades of existing workspaces only', () => {
    expect(pendingMigration()).toBeNull()
    seed(18)
    expect(pendingMigration()).toEqual({ language: 'ko' })
    rmSync(environment.directory, { recursive: true })
    mkdirSync(environment.directory)
    seed(18, 'en')
    expect(pendingMigration()).toEqual({ language: 'en' })
    expect(readdirSync(environment.directory)).not.toContain('backups')
  })

  it('backs up and migrates the database, leaving initDb only to open it', async () => {
    seed(18)
    await expect(migrateInWorker(bundle)).resolves.toBe(true)
    expect(version()).toBe(migrations.length)
    expect(readdirSync(backups())).toEqual(['pre-migration-v18.db'])
    expect(pendingMigration()).toBeNull()

    const initialized = initDb()
    expect(initialized).toMatchObject({ version: migrations.length, isNewDatabase: false })
    expect(getDb().prepare('SELECT file_path FROM images').all()).toEqual([
      { file_path: '/fixture/generated.png' }
    ])
  })

  it('rejects with the migration error and leaves the database at its version', async () => {
    seed(18)
    writeFileSync(backups(), 'blocked directory')
    await expect(migrateInWorker(bundle)).rejects.toThrow()
    expect(version()).toBe(18)
  })

  it('does not create a database that does not exist', async () => {
    await expect(migrateInWorker(bundle)).rejects.toThrow()
    expect(readdirSync(environment.directory)).toEqual([])
  })

  it('falls back to the main thread when the worker cannot run', async () => {
    seed(18)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(migrateInWorker(join(root, 'missing-worker.cjs'))).resolves.toBe(false)
    expect(logged).toHaveBeenCalledWith('DB migration worker failed:', expect.any(Error))
    logged.mockRestore()
    expect(version()).toBe(18)
  })
})
