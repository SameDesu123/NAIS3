import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { createNaisArchive, readNaisArchive } from './archive'
import { legacyNais3ToBackupDatabase, LEGACY_BACKUP_TABLES, LEGACY_OMITTED_COLUMNS } from './legacy'
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  backupFileKey,
  type BackupDatabase,
  type BackupFile,
  type BackupFileRef,
  type BackupRow,
  type BackupTableName,
  FILE_BACKED_TABLES,
  isSupportedBackupFormatVersion
} from './types'
import { captureLedger, mergeLedger, type BackupLedger, type LedgerFile } from './ledger'
import { getDb } from '../db'
import { locatorPath, syncExternalRoot } from '../db/media'
import { getSetting, setSetting } from '../db/settings'
import { externalImportRoot } from '../images/external'
import { libraryRoot } from '../images/storage'

type DbRow = Record<string, string | number | null | Buffer>

function encodeLegacyValue(value: DbRow[string]): unknown {
  if (Buffer.isBuffer(value)) return { __blob: value.toString('base64') }
  return value
}

function normalizedExtension(value: string): string {
  const extension = (value.startsWith('.') ? value : extname(value)).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin'
}

/** Preserve the original NAIS3 JSON export shape for older application versions. */
export function exportLegacyJson(): Record<string, unknown> {
  const db = getDb()
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const table of LEGACY_BACKUP_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as DbRow[]
    const omitted = new Set(LEGACY_OMITTED_COLUMNS[table] ?? [])
    tables[table] = rows.map((row) => {
      const output: Record<string, unknown> = {}
      for (const [column, value] of Object.entries(row)) {
        if (!omitted.has(column)) output[column] = encodeLegacyValue(value)
      }
      if (FILE_BACKED_TABLES.has(table) && typeof row.file_path === 'string') {
        try {
          output.__image = readFileSync(row.file_path).toString('base64')
        } catch {
          output.__image = null
        }
      }
      return output
    })
  }
  return {
    _app: 'NAIS3',
    _version: 1,
    mainParams: getSetting('main_params') || null,
    tables
  }
}

/**
 * Capture all portable workspace data. A row whose source file cannot be read is kept with an
 * empty file_path and reported in missingFiles.
 */
export function captureBackupDatabase(): BackupDatabase {
  const db = getDb()
  const tables: BackupDatabase['tables'] = {}
  const files: BackupFile[] = []
  const missingFiles: BackupFileRef[] = []

  for (const table of BACKUP_TABLES) {
    const sourceRows = db.prepare(`SELECT * FROM ${table}`).all() as DbRow[]
    const rows: BackupRow[] = []
    for (const sourceRow of sourceRows) {
      const row = { ...sourceRow }
      if (FILE_BACKED_TABLES.has(table)) {
        if (typeof row.id !== 'number' || typeof row.file_path !== 'string') {
          throw new Error(`${table} contains an invalid file row`)
        }
        const ref: BackupFileRef = { table, rowId: row.id, column: 'file_path' }
        try {
          files.push({
            ...ref,
            extension: normalizedExtension(row.file_path),
            data: readFileSync(row.file_path)
          })
        } catch {
          missingFiles.push(ref)
        }
        row.file_path = ''
      }
      rows.push(row)
    }
    tables[table] = rows
  }

  const ledger = captureLedger(db)
  return {
    version: BACKUP_FORMAT_VERSION,
    includedTables: [...BACKUP_TABLES],
    tables,
    mainParams: getSetting('main_params') || null,
    files,
    missingFiles,
    ledger,
    ledgerFiles: captureExternalCopies(ledger)
  }
}

/**
 * 외부 복사본 파일 — 이 기기의 external 루트에 있는 등록만. 다른 기기 경로(unmapped)와 읽을 수 없는
 * 파일은 담지 않는다 (등록은 원장에 남는다)
 */
function captureExternalCopies(ledger: BackupLedger): LedgerFile[] {
  const roots = new Map(
    ledger.roots
      .filter((root) => root.kind === 'external' && root.status !== 'unmapped')
      .map((root) => [root.id, root.path])
  )
  const files: LedgerFile[] = []
  for (const registration of ledger.registrations) {
    const rootPath = roots.get(registration.rootId)
    if (!rootPath) continue
    try {
      files.push({
        seq: registration.seq,
        extension: normalizedExtension(registration.relPath),
        data: readFileSync(locatorPath(rootPath, registration.relPath))
      })
    } catch {
      // 지워졌거나 오프라인 — 등록만 담는다
    }
  }
  return files
}

function hasSameBytes(path: string, data: Buffer): boolean {
  try {
    return statSync(path).size === data.length && readFileSync(path).equals(data)
  } catch {
    return false
  }
}

/**
 * 아카이브의 외부 복사본을 이 기기의 복사본 폴더에 쓴다 (복원 트랜잭션 전에). 파일마다 정한다 —
 * 아카이브의 루트 경로가 이 기기에도 루트로 있고 그 위치에 같은 내용이 있으면 쓰지 않는다
 * (원장 합치기가 위치로 중복을 거른다). 없거나 내용이 다르면 복사본 폴더에 쓴다.
 * 같은 이름(또는 _N)에 같은 내용이 있으면 그 파일을 쓰고, 없으면 _N 새 이름. 기존 파일을 덮어쓰지
 * 않는다. 복원이 실패해도 쓴 복사본은 지우지 않는다 (재인덱싱으로 다시 올릴 수 있다)
 */
function writeExternalCopies(
  ledger: BackupLedger,
  files: LedgerFile[]
): { rootId: number; relPaths: Map<number, string> } {
  const relPaths = new Map<number, string>()
  // 복사본이 없으면 복사본 폴더를 루트로 올리지 않는다 — rootId는 쓰이지 않는다
  if (files.length === 0) return { rootId: 0, relPaths }
  const db = getDb()
  const rootPath = externalImportRoot()
  const rootId = syncExternalRoot(db, rootPath)
  // unmapped 루트는 다른 기기에서 복원해 온 경로다 — 거기 등록하면 보이지 않는다
  const localRoots = new Set(
    db.prepare(`SELECT path FROM media_roots WHERE status != 'unmapped'`).pluck().all() as string[]
  )
  const archivedRoots = new Map(ledger.roots.map((root) => [root.id, root.path]))
  const registrations = new Map(ledger.registrations.map((r) => [r.seq, r]))
  for (const file of files) {
    const registration = registrations.get(file.seq)
    if (!registration) continue
    // 파일마다 본다 — 루트 경로가 같아도 새 기기(같은 사용자 경로)이거나 복사본을 지웠을 수 있다.
    // 이 기기의 루트에서 아카이브 위치에 같은 내용이 있을 때만 쓰지 않는다 (원장 합치기가 위치로 중복을 거른다)
    const archivedRoot = archivedRoots.get(registration.rootId)
    if (
      archivedRoot !== undefined &&
      localRoots.has(archivedRoot) &&
      hasSameBytes(locatorPath(archivedRoot, registration.relPath), file.data)
    )
      continue
    const relPath = registration.relPath
    const target = locatorPath(rootPath, relPath)
    const dir = dirname(target)
    mkdirSync(dir, { recursive: true })
    const ext = extname(relPath)
    const stem = basename(relPath, ext)
    const slash = relPath.lastIndexOf('/')
    for (let n = 1; ; n++) {
      const name = n === 1 ? basename(relPath) : `${stem}_${n}${ext}`
      const candidate = join(dir, name)
      // 같은 내용이 이미 있으면(다시 복원) 그 파일을 쓴다. 다른 파일이면 다음 번호
      if (existsSync(candidate) && !hasSameBytes(candidate, file.data)) continue
      try {
        if (!existsSync(candidate)) writeFileSync(candidate, file.data, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      relPaths.set(file.seq, slash < 0 ? name : `${relPath.slice(0, slash)}/${name}`)
      break
    }
  }
  return { rootId, relPaths }
}

export async function exportNais(appVersion: string): Promise<{
  archive: Buffer
  missingFiles: number
}> {
  const database = captureBackupDatabase()
  return {
    archive: await createNaisArchive(database, appVersion),
    missingFiles: database.missingFiles.length
  }
}

function tableColumns(table: BackupTableName): Set<string> {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

function validateRows(database: BackupDatabase): Partial<Record<BackupTableName, BackupRow[]>> {
  if (!isSupportedBackupFormatVersion(database.version)) {
    throw new Error(`Unsupported backup database version: ${database.version}`)
  }
  if (new Set(database.includedTables).size !== database.includedTables.length) {
    throw new Error('Backup database contains duplicate tables')
  }

  const result: Partial<Record<BackupTableName, BackupRow[]>> = {}
  for (const table of database.includedTables) {
    const rows = database.tables[table]
    if (!Array.isArray(rows)) throw new Error(`Backup database is missing table: ${table}`)
    const allowedColumns = tableColumns(table)
    result[table] = rows.map((sourceRow) => {
      const row: BackupRow = {}
      for (const [column, value] of Object.entries(sourceRow)) {
        if (!allowedColumns.has(column)) throw new Error(`Unknown ${table} column: ${column}`)
        if (
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'number' &&
          !Buffer.isBuffer(value)
        ) {
          throw new Error(`Invalid ${table}.${column} value`)
        }
        row[column] = value
      }
      if (typeof row.id !== 'number') throw new Error(`${table} row is missing a numeric id`)
      return row
    })
  }
  // folder_uuid는 씬 폴더 이름이 된다 — UUID가 아니면 새 UUID를 준다 (아카이브의 값이 경로가 되지 않게)
  for (const row of result.gen_scenes ?? []) {
    if (row.folder_uuid != null && !isFolderUuid(row.folder_uuid)) row.folder_uuid = randomUUID()
  }
  return result
}

function isFolderUuid(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

/**
 * Restore a validated snapshot, replacing only the tables declared by that format.
 * Rows listed in missingFiles come back with an empty file_path; missingFiles counts them.
 */
export function restoreBackupDatabase(database: BackupDatabase): {
  imported: number
  missingFiles: number
} {
  const tables = validateRows(database)
  const fileMap = new Map(database.files.map((file) => [backupFileKey(file), file]))
  const missing = new Set(database.missingFiles.map(backupFileKey))
  let missingFiles = 0
  const importRoot = join(libraryRoot(), '_imported', randomUUID())
  let wroteFiles = false

  try {
    for (const table of database.includedTables) {
      if (!FILE_BACKED_TABLES.has(table)) continue
      for (const row of tables[table] ?? []) {
        const key = backupFileKey({ table, rowId: row.id as number, column: 'file_path' })
        const file = fileMap.get(key)
        if (!file && missing.has(key)) {
          row.file_path = ''
          missingFiles++
          continue
        }
        if (!file) throw new Error(`Backup is missing the file for ${table} row ${row.id}`)
        const destination = join(
          importRoot,
          `${table}_${row.id}${normalizedExtension(file.extension)}`
        )
        mkdirSync(importRoot, { recursive: true })
        writeFileSync(destination, file.data, { flag: 'wx' })
        row.file_path = destination
        wroteFiles = true
      }
    }

    const copies = database.ledger
      ? writeExternalCopies(database.ledger, database.ledgerFiles ?? [])
      : null

    let imported = 0
    const db = getDb()
    const included = new Set(database.includedTables)
    const transaction = db.transaction(() => {
      for (const table of [...BACKUP_TABLES].reverse()) {
        if (included.has(table)) db.prepare(`DELETE FROM ${table}`).run()
      }
      for (const table of BACKUP_TABLES) {
        if (!included.has(table)) continue
        for (const row of tables[table] ?? []) {
          const columns = Object.keys(row)
          if (columns.length === 0) throw new Error(`${table} contains an empty row`)
          const placeholders = columns.map(() => '?').join(', ')
          db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(
            ...columns.map((column) => row[column])
          )
          imported++
        }
      }
      if (typeof database.mainParams === 'string') {
        setSetting('main_params', database.mainParams)
      }
      // 원장은 바꿔치기가 아니라 합치기 — gen_scenes를 넣은 뒤라 씬 귀속을 되살릴 수 있다
      if (database.ledger && copies) mergeLedger(db, database.ledger, copies)
    })
    transaction()
    return { imported, missingFiles }
  } catch (error) {
    if (wroteFiles && existsSync(importRoot)) {
      rmSync(importRoot, { recursive: true, force: true })
    }
    throw error
  }
}

export async function importNais(
  input: Buffer
): Promise<{ imported: number; missingFiles: number }> {
  return restoreBackupDatabase(await readNaisArchive(input))
}

export function importLegacyJson(data: Record<string, unknown>): {
  imported: number
  missingFiles: number
} {
  return restoreBackupDatabase(legacyNais3ToBackupDatabase(data))
}

// Compatibility exports for existing main-process call sites.
export const exportAll = exportLegacyJson
export function importAll(data: Record<string, unknown>): { imported: number } {
  return importLegacyJson(data)
}
