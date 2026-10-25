import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
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
import { getDb } from '../db'
import { getSetting, setSetting } from '../db/settings'
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

  return {
    version: BACKUP_FORMAT_VERSION,
    includedTables: [...BACKUP_TABLES],
    tables,
    mainParams: getSetting('main_params') || null,
    files,
    missingFiles
  }
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
  return result
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
