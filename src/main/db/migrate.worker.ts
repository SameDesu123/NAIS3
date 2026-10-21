import { parentPort, workerData } from 'worker_threads'
import {
  migrate,
  openDatabase,
  type MigrationWorkerData,
  type MigrationWorkerResult
} from './migrate'

const port = parentPort
if (!port) throw new Error('DB migration worker requires a parent port')

const { path, backupDir } = workerData as MigrationWorkerData
let result: MigrationWorkerResult
try {
  // 이미 있는 DB만 연다 — 여기서 새로 만들면 initDb가 새 설치를 기존 설치로 판정한다
  const db = openDatabase(path, { fileMustExist: true })
  try {
    migrate(db, backupDir)
  } finally {
    db.close()
  }
  result = { ok: true }
} catch (error) {
  result = { error: error instanceof Error ? error.message : String(error) }
}
port.postMessage(result)
