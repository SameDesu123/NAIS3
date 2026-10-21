import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { isLang, type Lang } from '../../shared/i18n'
import {
  migrate,
  openDatabase,
  pruneBackups,
  writeSnapshot,
  type MigrationWorkerData,
  type MigrationWorkerResult
} from './migrate'
import { migrations } from './migrations'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized — call initDb() first')
  return db
}

export function getDbPath(): string {
  return join(app.getPath('userData'), 'nais3.db')
}

function getBackupDir(): string {
  return join(app.getPath('userData'), 'backups')
}

/**
 * DB 열기 + 마이그레이션 (migrate.ts).
 *
 * WAL 모드: 크래시 시에도 커밋된 데이터 보존
 */
export function initDb(): { version: number; path: string; isNewDatabase: boolean } {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = getDbPath()
  // Capture this before SQLite creates the file. An empty settings table does not
  // mean a new installation: older workspaces may already contain user data.
  const isNewDatabase = !existsSync(path)

  db = openDatabase(path)
  migrate(db, getBackupDir())

  return { version: migrations.length, path, isNewDatabase }
}

/**
 * 백업·마이그레이션이 남은 기존 DB면 그 DB의 UI 언어를 돌려준다 (진행 창 표시용).
 * 새 DB(파일 없음·버전 0)는 백업이 없어 금방 끝나므로 null. 더 새 버전 DB는 initDb가 거부한다.
 */
export function pendingMigration(): { language: Lang } | null {
  const path = getDbPath()
  if (!existsSync(path)) return null
  const probe = new Database(path, { fileMustExist: true })
  try {
    const version = probe.pragma('user_version', { simple: true }) as number
    if (version === 0 || version >= migrations.length) return null
    // 언어 설정이 없는 기존 설치는 한국어 — resolveInitialLanguage와 같은 규칙
    let language: Lang = 'ko'
    try {
      const row = probe.prepare("SELECT value FROM settings WHERE key = 'ui_language'").get() as
        { value: unknown } | undefined
      if (isLang(row?.value)) language = row.value
    } catch {
      // settings 테이블이 없는 아주 오래된 DB
    }
    return { language }
  } finally {
    probe.close()
  }
}

/**
 * 남은 마이그레이션을 워커 스레드에서 적용한다. 큰 워크스페이스의 백업·인덱스 생성은 몇 분 걸리는데,
 * 메인 스레드가 그동안 막히면 다시 실행한 쪽의 single-instance 확인에 답하지 못하고
 * 20초 뒤 이 프로세스가 강제 종료된다 — 업그레이드가 실행할 때마다 처음부터 다시 시작된다.
 *
 * 마이그레이션 실패는 그 오류로 reject. 워커를 아예 돌리지 못했으면 false —
 * 그때는 initDb가 이전처럼 메인 스레드에서 마이그레이션한다.
 */
export function migrateInWorker(workerFile: string): Promise<boolean> {
  const workerData: MigrationWorkerData = { path: getDbPath(), backupDir: getBackupDir() }
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(workerFile, { workerData })
    } catch (error) {
      console.error('DB migration worker could not start:', error)
      resolve(false)
      return
    }
    worker.once('message', (result: MigrationWorkerResult) => {
      if ('error' in result) reject(new Error(result.error))
      else resolve(true)
    })
    worker.once('error', (error) => {
      console.error('DB migration worker failed:', error)
      resolve(false)
    })
    // 결과를 보내기 전에 끝난 경우만 해당 — 이미 정해진 Promise는 바뀌지 않는다
    worker.once('exit', () => resolve(false))
  })
}

/** 주기 백업용: 압축 정리된 스냅샷을 원자적으로 생성 */
export function backupNow(): string {
  const backupDir = getBackupDir()
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(backupDir, `auto-${stamp}.db`)
  writeSnapshot(getDb(), dest)
  pruneBackups(backupDir, 10)
  return dest
}

export function closeDb(): void {
  db?.close()
  db = null
}
