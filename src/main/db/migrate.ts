import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { isJobApplied, pendingEnsureSteps, pendingJobs } from './ensure'
import { migrations } from './migrations'

// electron에 의존하지 않는다 — 메인 스레드(initDb)와 마이그레이션 워커(migrate.worker.ts)가 같이 쓴다

export interface MigrationWorkerData {
  path: string
  backupDir: string
}

/** 워커는 DB를 연 직후 opened를, 끝나면 done 또는 error를 보낸다 */
export type MigrationWorkerMessage =
  // 언어 값은 검증 전 그대로 — i18n 카탈로그를 워커 번들에 넣지 않는다
  | { type: 'opened'; pending: boolean; uiLanguage: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string }

export function openDatabase(path: string, options?: Database.Options): Database.Database {
  const db = new Database(path, options)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

/**
 * 백업·마이그레이션·추가 스키마·한 번만 도는 작업이 남은 기존 DB인지. 버전만 보면 안 된다 —
 * 이미 v20인 DB도 추가 스키마(큰 images에 컬럼·인덱스)와 데이터 작업이 남을 수 있다.
 * 새 DB(버전 0)는 백업이 없어 금방 끝난다. 앱보다 새 DB는 migrate가 거절한다
 */
export function hasPendingUpgrade(db: Database.Database): boolean {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version === 0 || version > migrations.length) return false
  if (version < migrations.length) return true
  return pendingEnsureSteps(db).length > 0 || pendingJobs(db).length > 0
}

/** 저장된 UI 언어 (없으면 undefined). settings 테이블이 없는 아주 오래된 DB도 있다 */
export function readUiLanguage(db: Database.Database): unknown {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ui_language'").get() as
      { value: unknown } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

/**
 * 남은 마이그레이션 적용.
 *
 * 안전장치 (NAIS2 세이브 유실 문제의 근본 대책):
 * - 마이그레이션 필요 시 실행 전 파일 백업 자동 생성 (pre-migration-v{N}.db)
 * - 각 마이그레이션은 개별 트랜잭션: 실패하면 해당 버전 이전 상태로 남고 앱은 에러 표면화
 */
export function migrate(db: Database.Database, backupDir: string): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const target = migrations.length
  assertSupportedVersion(current, target)
  // 마이그레이션이 필요 없는 실행에서도 정리한다 — 1.0.28 첫 실행을 강제 종료하며 쌓인 .tmp는
  // 이미 v20까지 올라간 DB 옆에 남아 있다
  removeSnapshotTemps(backupDir)
  if (current !== target) {
    if (current > 0) {
      backupBeforeMigration(db, backupDir, current)
    }
    // 버전은 쓰기 잠금(IMMEDIATE)을 잡은 뒤 다시 읽는다 — 같은 DB를 연 다른 프로세스가 먼저
    // 적용한 마이그레이션을 또 실행해 "index ... already exists"로 실패하지 않도록
    const migrateNext = db.transaction((): boolean => {
      const v = db.pragma('user_version', { simple: true }) as number
      // 그사이 다른 프로세스가 더 새 버전으로 올렸을 수도 있다 — 첫 확인만으로는 막지 못한다
      assertSupportedVersion(v, target)
      if (v === target) return false
      migrations[v](db)
      db.pragma(`user_version = ${v + 1}`)
      return true
    })
    while (migrateNext.immediate()) {
      /* 한 버전씩 개별 트랜잭션으로 적용 */
    }
  }
  // 이미 최신 버전인 DB도 매 실행 확인한다 — 다운그레이드한 옛 앱이 쓰던 DB 포함
  ensureSchema(db, backupDir)
}

/**
 * 추가 전용 스키마(ensure.ts)를 맞추고, 남은 한 번짜리 작업을 돌린다.
 * 남은 것은 쓰기 잠금을 잡은 뒤 다시 고른다 — 다른 프로세스가 먼저 적용했을 수 있다.
 * 스키마는 한 트랜잭션, 작업은 각자 한 트랜잭션: 실패한 작업은 표시가 남지 않아 다음 실행에 다시 돈다
 */
function ensureSchema(db: Database.Database, backupDir: string): void {
  if (pendingEnsureSteps(db).length > 0) {
    db.transaction(() => {
      for (const step of pendingEnsureSteps(db)) step.apply(db)
    }).immediate()
  }

  const jobs = pendingJobs(db)
  if (jobs.length === 0) return
  // 작업은 데이터를 바꾼다 — 첫 작업 이름으로 실행 전 스냅샷
  mkdirSync(backupDir, { recursive: true })
  const snapshot = join(backupDir, `pre-job-${jobs[0].name}.db`)
  writeSnapshot(db, snapshot)
  pruneBackups(backupDir, 10, snapshot)
  for (const job of jobs) {
    db.transaction(() => {
      if (isJobApplied(db, job.name)) return
      job.run(db)
      db.prepare('INSERT INTO applied_jobs (name) VALUES (?)').run(job.name)
    }).immediate()
  }
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

function backupBeforeMigration(
  db: Database.Database,
  backupDir: string,
  fromVersion: number
): void {
  mkdirSync(backupDir, { recursive: true })
  const destination = join(backupDir, `pre-migration-v${fromVersion}.db`)
  writeSnapshot(db, destination)
  pruneBackups(backupDir, 10, destination)
}

/** Include committed WAL pages and replace an older backup only after the snapshot succeeds. */
export function writeSnapshot(db: Database.Database, destination: string): void {
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    db.prepare('VACUUM INTO ?').run(temporary)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * 스냅샷 도중 강제 종료되면 DB 크기만 한 .tmp(와 그 -journal)가 남는다 — 실행마다 쌓여
 * 디스크를 채우지 않게 정리
 */
function removeSnapshotTemps(backupDir: string): void {
  if (!existsSync(backupDir)) return
  for (const f of readdirSync(backupDir)) {
    if (f.endsWith('.tmp') || f.endsWith('.tmp-journal'))
      rmSync(join(backupDir, f), { force: true })
  }
}

/**
 * 접두사(pre-migration·pre-import·auto…)와 상관없이 오래된 스냅샷부터 지운다. 이름순으로 고르면
 * pre-import-*가 pre-migration-v*보다 앞에 놓여 방금 쓴 스냅샷이 바로 지워진다.
 * keepPath(방금 만든 스냅샷)는 개수와 상관없이 남긴다
 */
export function pruneBackups(backupDir: string, keep: number, keepPath?: string): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((name) => ({
      name,
      path: join(backupDir, name),
      mtime: statSync(join(backupDir, name)).mtimeMs
    }))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
  const removable = files.filter((f) => keepPath === undefined || f.path !== keepPath)
  const excess = Math.max(0, files.length - keep)
  for (const f of removable.slice(0, excess)) rmSync(f.path)
}
