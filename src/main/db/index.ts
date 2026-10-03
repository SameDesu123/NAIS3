import Database from 'better-sqlite3'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { migrations } from './migrations'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized — call initDb() first')
  return db
}

export function getDbPath(): string {
  return join(app.getPath('userData'), 'nais3.db')
}

/**
 * DB 열기 + 마이그레이션.
 *
 * 안전장치 (NAIS2 세이브 유실 문제의 근본 대책):
 * - WAL 모드: 크래시 시에도 커밋된 데이터 보존
 * - 마이그레이션 필요 시 실행 전 파일 백업 자동 생성 (pre-migration-v{N}.db)
 * - 각 마이그레이션은 개별 트랜잭션: 실패하면 해당 버전 이전 상태로 남고 앱은 에러 표면화
 */
export function initDb(): { version: number; path: string; isNewDatabase: boolean } {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = getDbPath()
  // Capture this before SQLite creates the file. An empty settings table does not
  // mean a new installation: older workspaces may already contain user data.
  const isNewDatabase = !existsSync(path)

  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const current = db.pragma('user_version', { simple: true }) as number
  const target = migrations.length

  if (current < target) {
    if (current > 0) {
      backupBeforeMigration(current)
    }
    for (let v = current; v < target; v++) {
      const migrate = db.transaction(() => {
        migrations[v](db!)
        db!.pragma(`user_version = ${v + 1}`)
      })
      migrate()
    }
  } else if (current > target) {
    // 다운그레이드된 앱이 미래 버전 DB를 여는 상황 — 조용히 진행하면 데이터가 깨진다
    throw new Error(
      `DB version ${current} is newer than app supports (${target}). ` +
        'NAIS3를 최신 버전으로 업데이트하세요.'
    )
  }

  return { version: target, path, isNewDatabase }
}

function backupBeforeMigration(fromVersion: number): void {
  const backupDir = join(app.getPath('userData'), 'backups')
  mkdirSync(backupDir, { recursive: true })
  writeSnapshot(join(backupDir, `pre-migration-v${fromVersion}.db`))
  pruneBackups(backupDir, 10)
}

/** Include committed WAL pages and replace an older backup only after the snapshot succeeds. */
function writeSnapshot(destination: string): void {
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    getDb().prepare('VACUUM INTO ?').run(temporary)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function pruneBackups(backupDir: string, keep: number): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, f))
  }
}

/** 주기 백업용: 압축 정리된 스냅샷을 원자적으로 생성 */
export function backupNow(): string {
  const backupDir = join(app.getPath('userData'), 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(backupDir, `auto-${stamp}.db`)
  writeSnapshot(dest)
  pruneBackups(backupDir, 10)
  return dest
}

export function closeDb(): void {
  db?.close()
  db = null
}
