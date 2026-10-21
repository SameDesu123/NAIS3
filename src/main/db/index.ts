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
  assertSupportedVersion(current, target)

  if (current < target) {
    if (current > 0) {
      backupBeforeMigration(current)
    }
    // 버전은 쓰기 잠금(IMMEDIATE)을 잡은 뒤 다시 읽는다 — 같은 DB를 연 다른 프로세스가 먼저
    // 적용한 마이그레이션을 또 실행해 "index ... already exists"로 실패하지 않도록
    const migrateNext = db.transaction((): boolean => {
      const v = db!.pragma('user_version', { simple: true }) as number
      // 그사이 다른 프로세스가 더 새 버전으로 올렸을 수도 있다 — 첫 확인만으로는 막지 못한다
      assertSupportedVersion(v, target)
      if (v === target) return false
      migrations[v](db!)
      db!.pragma(`user_version = ${v + 1}`)
      return true
    })
    while (migrateNext.immediate()) {
      /* 한 버전씩 개별 트랜잭션으로 적용 */
    }
  }

  return { version: target, path, isNewDatabase }
}

function assertSupportedVersion(version: number, target: number): void {
  // 다운그레이드된 앱이 미래 버전 DB를 여는 상황 — 조용히 진행하면 데이터가 깨진다
  if (version > target) {
    throw new Error(
      `DB version ${version} is newer than app supports (${target}). ` +
        'NAIS3를 최신 버전으로 업데이트하세요.'
    )
  }
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
  const entries = readdirSync(backupDir)
  // 스냅샷 도중 강제 종료되면 DB 크기만 한 .tmp(와 그 -journal)가 남는다 — 실행마다 쌓여
  // 디스크를 채우지 않게 정리
  for (const f of entries.filter((f) => f.endsWith('.tmp') || f.endsWith('.tmp-journal'))) {
    rmSync(join(backupDir, f), { force: true })
  }
  const files = entries.filter((f) => f.endsWith('.db')).sort()
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
