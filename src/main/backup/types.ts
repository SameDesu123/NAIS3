import type { BackupLedger, LedgerFile } from './ledger'

/**
 * Version written by new exports. v2 keeps file-backed rows whose source file is missing and lists
 * them in missingFiles. Readers accept every supported version; older apps refuse v2 archives.
 */
export const BACKUP_FORMAT_VERSION = 2 as const
export const SUPPORTED_BACKUP_FORMAT_VERSIONS = [1, BACKUP_FORMAT_VERSION] as const
export type BackupFormatVersion = (typeof SUPPORTED_BACKUP_FORMAT_VERSIONS)[number]

/**
 * Portable studio tables. A restore replaces exactly the tables an archive declares.
 *
 * Contract for the media ledger in db/ensure.ts (media_roots, history_state, media_hidden,
 * media_registrations, scene_sources) and later scene_favorites:
 * - It lives in nais3.db itself, so the automatic DB snapshots (VACUUM INTO) include it.
 * - It is not a replaced table. .nais carries it separately (data/ledger.json, backup/ledger.ts)
 *   with user choices and external copies, and a restore merges it: device-local absolute roots
 *   never become active roots on another machine (media_roots.status 'unmapped'), registrations
 *   are deduped by location, hides are only added, and history_state is never replaced.
 * - Tables an archive does not declare are left untouched by a restore. Rows keyed by a scene id
 *   follow the replaced gen_scenes through their foreign keys: scene_sources rows are deleted and
 *   media_registrations.scene_id is cleared, so nothing points at a different scene. The ledger
 *   merge then puts back what the archive recorded for the restored scenes.
 * - gen_scenes.folder_uuid travels with gen_scenes; the legacy JSON export leaves it out.
 */
export const BACKUP_TABLES = [
  'character_folders',
  'character_prompts',
  'fragment_folders',
  'fragments',
  'vibe_folders',
  'vibe_images',
  'charref_folders',
  'charref_images',
  'scene_presets',
  'gen_scenes',
  'prompt_presets',
  'library_stacks',
  'library_images'
] as const

export type BackupTableName = (typeof BACKUP_TABLES)[number]
export type BackupRow = Record<string, string | number | null | Buffer>

/** Tables whose rows point at a file that the archive carries as an asset. */
export const FILE_BACKED_TABLES: ReadonlySet<BackupTableName> = new Set<BackupTableName>([
  'vibe_images',
  'charref_images',
  'library_images'
])

export interface BackupFileRef {
  table: BackupTableName
  rowId: number
  column: 'file_path'
}

export interface BackupFile extends BackupFileRef {
  extension: string
  data: Buffer
}

/**
 * Normalized in-memory backup model. Both .nais archives and legacy NAIS3 JSON
 * are converted to this type before restore.
 */
export interface BackupDatabase {
  version: BackupFormatVersion
  includedTables: BackupTableName[]
  tables: Partial<Record<BackupTableName, BackupRow[]>>
  mainParams: string | null
  files: BackupFile[]
  /**
   * File-backed rows kept without their source file. The row still holds a thumbnail, settings
   * and paid vibe encodings, so it is restored with an empty file_path instead of being dropped.
   */
  missingFiles: BackupFileRef[]
  /** Media ledger (v2 archives written since E2). Absent: a restore leaves the ledger alone. */
  ledger?: BackupLedger
  /** External copies, matched to ledger registrations by their archived seq */
  ledgerFiles?: LedgerFile[]
}

export interface NaisArchiveManifest {
  format: 'NAIS'
  formatVersion: BackupFormatVersion
  app: 'NAIS3'
  appVersion: string
  createdAt: string
  scope: 'workspace'
  tables: BackupTableName[]
  tableCounts: Partial<Record<BackupTableName, number>>
  /** v2 only */
  missingFiles?: BackupFileRef[]
  /** v2 only: data/ledger.json is present */
  ledger?: { registrations: number; files: number }
}

export function isBackupTableName(value: unknown): value is BackupTableName {
  return typeof value === 'string' && (BACKUP_TABLES as readonly string[]).includes(value)
}

export function isSupportedBackupFormatVersion(value: unknown): value is BackupFormatVersion {
  return (SUPPORTED_BACKUP_FORMAT_VERSIONS as readonly unknown[]).includes(value)
}

export function backupFileKey(ref: BackupFileRef): string {
  return `${ref.table}:${ref.rowId}:${ref.column}`
}
