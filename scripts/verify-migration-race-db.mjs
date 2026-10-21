import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Database side of verify-migration-race.mjs. Runs in the packaged app's Node mode
// (ELECTRON_RUN_AS_NODE=1) so it loads the shipped better-sqlite3 from app.asar.
//   seed <better-sqlite3 dir> <migrations.cjs> <db file> <images> <thumbnail bytes>
//   inspect <better-sqlite3 dir> <userData dir>
const require = createRequire(import.meta.url)
const [command, sqlite, ...args] = process.argv.slice(2)
const Database = require(sqlite)
const INDEXES = [
  'idx_images_file_path',
  'idx_images_scene_favorite',
  'idx_library_images_stack_order'
]

if (command === 'seed') {
  const [migrationsFile, file, images, bytes] = args
  const { migrations } = require(migrationsFile)
  const db = new Database(file)
  // Seeding only: no journal, so a ~1 GiB fixture does not take minutes to write.
  db.pragma('journal_mode = OFF')
  db.pragma('synchronous = OFF')
  for (let version = 0; version < 18; version++)
    db.transaction(() => {
      migrations[version](db)
      db.pragma(`user_version = ${version + 1}`)
    })()
  db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
    INSERT INTO gen_scenes (id, name) SELECT i, 'scene ' || i FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${Number(images)})
    INSERT INTO images (file_path, thumbnail, payload_json, scene_id, favorite, seed)
      SELECT '/ci/seed/image-' || i || '.png', randomblob(${Number(bytes)}), '{}', i % 20 + 1,
        i % 7 = 0, i FROM n;
  `)
  // Existing workspaces are WAL databases.
  db.pragma('journal_mode = WAL')
  const report = {
    version: db.pragma('user_version', { simple: true }),
    images: db.prepare('SELECT count(*) AS n FROM images').get().n,
    target: migrations.length
  }
  db.close()
  console.log(JSON.stringify({ ...report, bytes: statSync(file).size }))
} else if (command === 'inspect') {
  const [userData] = args
  const db = new Database(join(userData, 'nais3.db'), { fileMustExist: true })
  const report = {
    version: db.pragma('user_version', { simple: true }),
    integrity: db.pragma('integrity_check', { simple: true }),
    indexes: db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?)`)
      .all(...INDEXES)
      .map((row) => row.name)
      .sort()
  }
  db.close()
  const directory = join(userData, 'backups')
  const files = existsSync(directory) ? readdirSync(directory).sort() : []
  report.backups = files
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const backup = new Database(join(directory, name), { readonly: true, fileMustExist: true })
      try {
        return {
          name,
          version: backup.pragma('user_version', { simple: true }),
          integrity: backup.pragma('quick_check', { simple: true })
        }
      } finally {
        backup.close()
      }
    })
  report.leftovers = files.filter((name) => !name.endsWith('.db'))
  console.log(JSON.stringify(report))
} else {
  throw new Error(`Unknown command: ${command}`)
}
