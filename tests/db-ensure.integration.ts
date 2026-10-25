import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { ensureSteps, oneTimeJobs, pendingEnsureSteps } from '../src/main/db/ensure'
import { hasPendingUpgrade } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'ko' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let root: string
const path = (): string => join(environment.directory, 'nais3.db')
const backups = (): string => join(environment.directory, 'backups')

/** A v20 workspace as 1.0.29 leaves it: numbered migrations only, no ensure steps. */
function seedV20(): void {
  const db = new Database(path())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (let v = 0; v < migrations.length; v++)
    db.transaction(() => {
      migrations[v](db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  db.exec(`
    INSERT INTO gen_scenes (id, name, prompt) VALUES (1, '장면', 'scene prompt');
    INSERT INTO images (id, file_path, thumbnail, payload_json, scene_id, favorite)
      VALUES (1, '/fixture/generated.png', X'0102', '{}', 1, 1);
  `)
  db.close()
}

function pending(): boolean {
  const db = new Database(path(), { readonly: true, fileMustExist: true })
  try {
    return hasPendingUpgrade(db)
  } finally {
    db.close()
  }
}

function schema(db: Database.Database): { name: string; sql: string }[] {
  return db
    .prepare('SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name')
    .all() as { name: string; sql: string }[]
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-ensure-'))
  environment.directory = join(root, 'workspace')
  mkdirSync(environment.directory)
})

afterEach(() => {
  closeDb()
  oneTimeJobs.length = 0
  rmSync(root, { recursive: true, force: true })
})

describe('additive schema ensure at user_version 20', () => {
  it('applies to a v20 database without changing its version, data or backups', () => {
    seedV20()
    expect(pending()).toBe(true)

    initDb()
    const db = getDb()
    expect(db.pragma('user_version', { simple: true })).toBe(20)
    expect(pendingEnsureSteps(db)).toEqual([])
    expect(db.prepare('SELECT * FROM history_state').all()).toEqual([
      { id: 1, next_seq: 1, cleared_seq: 0 }
    ])
    expect(db.prepare('SELECT id, name, folder_uuid FROM gen_scenes').all()).toEqual([
      { id: 1, name: '장면', folder_uuid: null }
    ])
    expect(db.prepare('SELECT id, scene_id, favorite, seq FROM images').all()).toEqual([
      { id: 1, scene_id: 1, favorite: 1, seq: null }
    ])
    // Additive changes take no snapshot; only version changes and data jobs do.
    expect(existsSync(backups())).toBe(false)
    closeDb()
    expect(pending()).toBe(false)
  })

  it('runs on a new installation too', () => {
    initDb()
    expect(pendingEnsureSteps(getDb())).toEqual([])
    expect(getDb().pragma('user_version', { simple: true })).toBe(migrations.length)
  })

  it('is idempotent and adds only the missing steps', () => {
    seedV20()
    initDb()
    const first = schema(getDb())
    getDb().exec('DROP INDEX idx_scene_sources_scene')
    closeDb()
    expect(pending()).toBe(true)

    initDb()
    expect(schema(getDb())).toEqual(first)
    closeDb()
    initDb()
    expect(schema(getDb())).toEqual(first)
  })

  it('never reruns seeds when an existing v20 database is ensured', () => {
    seedV20()
    const db = new Database(path())
    db.exec('DELETE FROM fragments; DELETE FROM fragment_folders;')
    db.close()

    initDb()
    expect(getDb().prepare('SELECT COUNT(*) FROM fragments').pluck().get()).toBe(0)
  })

  it('keeps the statements of 1.0.29 working on an ensured database', () => {
    seedV20()
    initDb()
    const db = getDb()
    // Copied from 1.0.29: scenes/repo.ts createScene and images/storage.ts saveImage
    db.prepare(
      'INSERT INTO gen_scenes (preset_id, name, width, height, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'old app scene', 832, 1216, 2)
    db.prepare(
      'INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('/fixture/old.png', Buffer.from([1]), 'generate', 1, '{}', 1)
    expect(
      db.prepare("SELECT folder_uuid FROM gen_scenes WHERE name = 'old app scene'").pluck().get()
    ).toBeNull()
    expect(
      db.prepare("SELECT seq FROM images WHERE file_path = '/fixture/old.png'").pluck().get()
    ).toBeNull()
  })

  it('keeps visibility scopes apart and follows scene deletion through foreign keys', () => {
    seedV20()
    initDb()
    const db = getDb()
    db.exec(`
      INSERT INTO media_roots (id, kind, path, path_key) VALUES (1, 'scene', '/저장', '/저장');
      INSERT INTO scene_sources (scene_id, root_id, rel_dir, dir_key, role)
        VALUES (1, 1, 'uuid', 'uuid', 'write');
      INSERT INTO media_registrations (seq, root_id, rel_path, path_key, source, scene_id)
        VALUES (1, 1, 'uuid/장면_1.png', 'uuid/장면_1.png', 'generated', 1);
      INSERT INTO media_hidden (seq, scope) VALUES (1, 'history'), (1, 'scene');
    `)
    expect(() => db.exec("INSERT INTO media_hidden (seq, scope) VALUES (2, 'all')")).toThrow(
      'CHECK constraint failed'
    )

    db.prepare('DELETE FROM gen_scenes WHERE id = 1').run()
    expect(db.prepare('SELECT COUNT(*) FROM scene_sources').pluck().get()).toBe(0)
    expect(db.prepare('SELECT seq, scene_id FROM media_registrations').all()).toEqual([
      { seq: 1, scene_id: null }
    ])
    expect(db.prepare('SELECT COUNT(*) FROM media_hidden').pluck().get()).toBe(2)
  })

  it('declares every step it applies', () => {
    initDb()
    for (const step of ensureSteps) expect(step.isApplied(getDb()), step.name).toBe(true)
  })
})

describe('one-time jobs', () => {
  it('runs a job once, after a snapshot, and records it', () => {
    seedV20()
    initDb()
    closeDb()
    const run = vi.fn((db: Database.Database) => {
      db.prepare('UPDATE images SET seq = 1 WHERE id = 1').run()
    })
    oneTimeJobs.push({ name: 'test-job', run })
    expect(pending()).toBe(true)

    initDb()
    expect(run).toHaveBeenCalledTimes(1)
    expect(getDb().prepare('SELECT seq FROM images').pluck().get()).toBe(1)
    expect(getDb().prepare('SELECT name FROM applied_jobs').pluck().all()).toEqual(['test-job'])
    expect(readdirSync(backups())).toEqual(['pre-job-test-job.db'])
    closeDb()
    expect(pending()).toBe(false)

    initDb()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rolls back a failed job without recording it, so the next start retries', () => {
    seedV20()
    oneTimeJobs.push({
      name: 'failing-job',
      run: (db) => {
        db.prepare('UPDATE images SET seq = 7').run()
        throw new Error('Injected job failure')
      }
    })
    expect(() => initDb()).toThrow('Injected job failure')
    // The schema transaction committed before the job ran
    expect(pendingEnsureSteps(getDb())).toEqual([])
    expect(getDb().prepare('SELECT seq FROM images').pluck().get()).toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) FROM applied_jobs').pluck().get()).toBe(0)
    closeDb()

    oneTimeJobs[0].run = (db) => db.prepare('UPDATE images SET seq = 7').run()
    initDb()
    expect(getDb().prepare('SELECT seq FROM images').pluck().get()).toBe(7)
  })
})
