import { RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageId } from '@shared/i18n'
import type {
  AppStorageKey,
  AppStorageUsage,
  SaveFolderUsage,
  StorageUsageTotal
} from '@shared/types'
import { formatBytes } from '../lib/format-bytes'
import { useLanguageStore, useT } from '../lib/i18n'
import { Button } from './ui/button'

const APP_LABELS: Record<AppStorageKey, MessageId> = {
  database: 'ui.storageDatabase',
  backups: 'ui.storageBackups',
  library: 'ui.storageLibrary',
  refs: 'ui.storageRefs'
}

const FOLDER_LABELS: Record<SaveFolderUsage['target'], MessageId> = {
  main: 'ui.mainSaveFolder',
  scene: 'ui.sceneSaveFolder'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function UsageRow({
  label,
  usage,
  title,
  strong
}: {
  label: string
  usage: StorageUsageTotal
  title?: string
  strong?: boolean
}): React.JSX.Element {
  const t = useT()
  const lang = useLanguageStore((s) => s.lang)
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-1.5" title={title}>
      <p className={strong ? 'min-w-0 text-[13px] text-ink' : 'min-w-0 text-[12.5px] text-muted'}>
        {label}
      </p>
      <p className="shrink-0 text-right text-[12.5px] tabular-nums text-ink">
        {usage.exists ? (
          <>
            {formatBytes(usage.bytes, lang)}
            <span className="ml-1.5 text-faint">
              {t('ui.storageFiles', usage.files.toLocaleString(lang))}
            </span>
          </>
        ) : (
          <span className="text-faint">{t('ui.storageNotCreated')}</span>
        )}
      </p>
    </div>
  )
}

/**
 * 설정 > 저장의 사용 용량. 앱 데이터는 탭을 열 때 바로 세고,
 * 저장 폴더는 수만 장일 수 있어 버튼을 눌렀을 때만 센다 (같은 버튼으로 취소).
 * saveDirsVersion이 바뀌면(저장 폴더 변경) 이전 폴더 결과를 지운다.
 */
export function StorageUsage({ saveDirsVersion }: { saveDirsVersion: number }): React.JSX.Element {
  const t = useT()
  const [appItems, setAppItems] = useState<AppStorageUsage[] | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  // 결과마다 집계 당시의 저장 폴더 버전을 붙여, 폴더를 바꾼 뒤에는 이전 결과를 보이지 않는다
  const [folderResult, setFolderResult] = useState<
    | { version: number; folders: SaveFolderUsage[]; overlap: boolean }
    | { version: number; error: string }
    | null
  >(null)
  const [measuring, setMeasuring] = useState(false)
  const mounted = useRef(true)
  const measuringRef = useRef(false)
  const appRequest = useRef(0)

  const fetchAppUsage = useCallback(() => {
    // 새로고침을 연달아 눌러도 마지막 요청의 결과만 보인다
    const request = ++appRequest.current
    const current = (): boolean => mounted.current && request === appRequest.current
    window.nais
      .invoke('storage:appUsage', undefined)
      .then((result) => {
        if (current()) setAppItems(result.items)
      })
      .catch((error: unknown) => {
        if (current()) setAppError(errorText(error))
      })
  }, [])

  function reloadAppUsage(): void {
    setAppItems(null)
    setAppError(null)
    fetchAppUsage()
  }

  useEffect(() => {
    mounted.current = true
    fetchAppUsage()
    return () => {
      mounted.current = false
      // 탭을 떠나거나 설정을 닫으면 메인의 폴더 집계도 멈춘다
      if (measuringRef.current) void window.nais.invoke('storage:cancelSaveFolderUsage', undefined)
    }
  }, [fetchAppUsage])

  // 저장 폴더를 바꾸면 진행 중인 집계는 이전 폴더 기준이라 취소한다
  useEffect(() => {
    if (saveDirsVersion > 0 && measuringRef.current)
      void window.nais.invoke('storage:cancelSaveFolderUsage', undefined)
  }, [saveDirsVersion])

  async function measureFolders(): Promise<void> {
    if (measuringRef.current) {
      void window.nais.invoke('storage:cancelSaveFolderUsage', undefined)
      return
    }
    const version = saveDirsVersion
    measuringRef.current = true
    setMeasuring(true)
    try {
      const result = await window.nais.invoke('storage:saveFolderUsage', undefined)
      if (mounted.current && !('canceled' in result)) setFolderResult({ version, ...result })
    } catch (error) {
      if (mounted.current) setFolderResult({ version, error: errorText(error) })
    } finally {
      measuringRef.current = false
      if (mounted.current) setMeasuring(false)
    }
  }

  const current = folderResult?.version === saveDirsVersion ? folderResult : null
  const folders = current && 'folders' in current ? current : null
  const folderError = current && 'error' in current ? current.error : null
  const appTotal: StorageUsageTotal | null = appItems && {
    bytes: appItems.reduce((sum, item) => sum + item.bytes, 0),
    files: appItems.reduce((sum, item) => sum + item.files, 0),
    exists: true,
    incomplete: appItems.some((item) => item.incomplete)
  }
  const foldersIncomplete = folders?.folders.some((folder) => folder.incomplete) ?? false

  return (
    <div className="mt-1 border-t border-line pt-3">
      <p className="text-[13px] text-ink">{t('ui.storageUsage')}</p>

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-muted">{t('ui.storageAppData')}</p>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('ui.reload')}
          title={t('ui.reload')}
          onClick={reloadAppUsage}
        >
          <RotateCcw size={13} />
        </Button>
      </div>
      <div aria-live="polite">
        {appError ? (
          <p className="py-1.5 text-[12px] text-danger">{t('ui.storageMeasureFailed', appError)}</p>
        ) : !appItems || !appTotal ? (
          <p className="py-1.5 text-[12px] text-faint">{t('ui.storageMeasuring')}</p>
        ) : (
          <>
            <div className="divide-y divide-line/60">
              {appItems.map((item) => (
                <UsageRow key={item.key} label={t(APP_LABELS[item.key])} usage={item} />
              ))}
              <UsageRow label={t('ui.storageTotal')} usage={appTotal} strong />
            </div>
            {appTotal.incomplete && (
              <p className="mt-1 text-[11.5px] text-faint">{t('ui.storageIncomplete')}</p>
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-[12px] font-medium text-muted">{t('ui.storageSaveFolders')}</p>
          <p className="mt-0.5 text-[11.5px] text-faint">{t('ui.storageSaveFoldersHint')}</p>
        </div>
        <Button variant="default" size="sm" onClick={() => void measureFolders()}>
          {measuring
            ? t('ui.cancel')
            : folders
              ? t('ui.storageRecalculate')
              : t('ui.storageCalculate')}
        </Button>
      </div>
      <div aria-live="polite">
        {measuring ? (
          <p className="py-1.5 text-[12px] text-faint">{t('ui.storageMeasuring')}</p>
        ) : folderError ? (
          <p className="py-1.5 text-[12px] text-danger">
            {t('ui.storageMeasureFailed', folderError)}
          </p>
        ) : (
          folders && (
            <>
              <div className="divide-y divide-line/60">
                {folders.folders.map((folder) => (
                  <UsageRow
                    key={folder.target}
                    label={t(FOLDER_LABELS[folder.target])}
                    usage={folder}
                    title={folder.path}
                  />
                ))}
              </div>
              {folders.overlap && (
                <p className="mt-1 text-[11.5px] text-faint">{t('ui.storageFoldersOverlap')}</p>
              )}
              {foldersIncomplete && (
                <p className="mt-1 text-[11.5px] text-faint">{t('ui.storageIncomplete')}</p>
              )}
            </>
          )
        )}
      </div>
    </div>
  )
}
