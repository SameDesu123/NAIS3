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
import { cn } from '../lib/utils'
import { Button } from './ui/button'

const APP_LABELS: Record<AppStorageKey, MessageId> = {
  database: 'ui.storageDatabase',
  backups: 'ui.storageBackups',
  library: 'ui.storageLibrary',
  refs: 'ui.storageRefs'
}

// 색은 순위가 아니라 항목에 고정한다 — 폴더 결과가 붙거나 빠져도 기존 구간의 색이 바뀌지 않는다
const COLORS = {
  database: 'bg-chart-1',
  backups: 'bg-chart-2',
  library: 'bg-chart-3',
  refs: 'bg-chart-4',
  main: 'bg-chart-5',
  scene: 'bg-chart-6'
} as const

interface Segment {
  id: string
  label: string
  color: string
  usage: StorageUsageTotal
  title?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function folderLabel(folder: SaveFolderUsage, t: ReturnType<typeof useT>): string {
  if (folder.targets.length > 1) return t('ui.storageSharedSaveFolder')
  return folder.targets[0] === 'main' ? t('ui.mainSaveFolder') : t('ui.sceneSaveFolder')
}

function sumUsage(items: readonly StorageUsageTotal[]): StorageUsageTotal {
  return {
    bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    files: items.reduce((sum, item) => sum + item.files, 0),
    exists: true,
    incomplete: items.some((item) => item.incomplete)
  }
}

/** 한 줄 막대 — 구간 폭은 바이트 비율. 0바이트 구간은 그리지 않고, 아주 작은 구간도 보이게 최소 폭을 둔다 */
function UsageBar({ segments, total }: { segments: Segment[]; total: number }): React.JSX.Element {
  const lang = useLanguageStore((s) => s.lang)
  const visible = total > 0 ? segments.filter((segment) => segment.usage.bytes > 0) : []
  return (
    // 같은 값은 아래 범례가 글자로 모두 보여 주므로 막대는 보조 장치로 숨긴다
    <div aria-hidden="true" className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
      {visible.length === 0 ? (
        <div className="h-full flex-1 bg-surface-2" />
      ) : (
        visible.map((segment) => (
          <div
            key={segment.id}
            className={cn('h-full min-w-1', segment.color)}
            style={{ flex: `${segment.usage.bytes / total} 1 0` }}
            title={`${segment.label}: ${formatBytes(segment.usage.bytes, lang)}`}
          />
        ))
      )}
    </div>
  )
}

function LegendRow({ segment }: { segment: Segment }): React.JSX.Element {
  const t = useT()
  const lang = useLanguageStore((s) => s.lang)
  const { usage } = segment
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-4 py-1.5" title={segment.title}>
      <span className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-muted">
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 translate-y-[-1px] rounded-full', segment.color)}
        />
        <span className="min-w-0">{segment.label}</span>
      </span>
      <span className="shrink-0 text-right text-[12.5px] tabular-nums text-ink">
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
      </span>
    </li>
  )
}

/**
 * 설정 > 시스템의 저장 공간 사용량. 앱 데이터는 탭을 열 때 바로 세고,
 * 저장 폴더는 수만 장일 수 있어 버튼을 눌렀을 때만 센다 (같은 버튼으로 취소).
 * 모두 한 막대에 색으로 나눠 보여 준다 — 저장 폴더 결과가 오면 막대에 구간이 더해진다.
 */
export function StorageUsage(): React.JSX.Element {
  const t = useT()
  const lang = useLanguageStore((s) => s.lang)
  const [appItems, setAppItems] = useState<AppStorageUsage[] | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [folderResult, setFolderResult] = useState<
    { folders: SaveFolderUsage[]; overlap: boolean } | { error: string } | null
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

  async function measureFolders(): Promise<void> {
    if (measuringRef.current) {
      void window.nais.invoke('storage:cancelSaveFolderUsage', undefined)
      return
    }
    measuringRef.current = true
    setMeasuring(true)
    try {
      const result = await window.nais.invoke('storage:saveFolderUsage', undefined)
      if (mounted.current && !('canceled' in result)) setFolderResult(result)
    } catch (error) {
      if (mounted.current) setFolderResult({ error: errorText(error) })
    } finally {
      measuringRef.current = false
      if (mounted.current) setMeasuring(false)
    }
  }

  const folders = folderResult && 'folders' in folderResult ? folderResult : null
  const folderError = folderResult && 'error' in folderResult ? folderResult.error : null

  const segments: Segment[] = [
    ...(appItems ?? []).map((item) => ({
      id: item.key,
      label: t(APP_LABELS[item.key]),
      color: COLORS[item.key],
      usage: item
    })),
    ...(folders?.folders ?? []).map((folder) => ({
      id: folder.targets.join('-'),
      label: folderLabel(folder, t),
      color: COLORS[folder.targets[0]],
      usage: folder,
      title: folder.path
    }))
  ]
  const total = sumUsage(segments.map((segment) => segment.usage))

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] text-ink">{t('ui.storageUsage')}</p>
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
            <p className="py-1.5 text-[12px] text-danger-ink">
              {t('ui.storageMeasureFailed', appError)}
            </p>
          ) : !appItems ? (
            <p className="py-1.5 text-[12px] text-faint">{t('ui.storageMeasuring')}</p>
          ) : (
            <>
              <p className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums">
                <span className="text-[20px] font-semibold text-ink">
                  {formatBytes(total.bytes, lang)}
                </span>
                <span className="text-[12px] text-faint">
                  {t('ui.storageTotal')} · {t('ui.storageFiles', total.files.toLocaleString(lang))}
                </span>
              </p>
              <div className="mt-2.5">
                <UsageBar segments={segments} total={total.bytes} />
              </div>
              <ul className="mt-2 divide-y divide-line/60">
                {segments.map((segment) => (
                  <LegendRow key={segment.id} segment={segment} />
                ))}
              </ul>
              {total.incomplete && (
                <p className="mt-1 text-[11.5px] text-faint">{t('ui.storageIncomplete')}</p>
              )}
              {folders?.overlap && (
                <p className="mt-1 text-[11.5px] text-faint">{t('ui.storageFoldersOverlap')}</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1 basis-40">
            <p className="text-[12.5px] text-ink">{t('ui.storageSaveFolders')}</p>
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
          ) : (
            folderError && (
              <p className="py-1.5 text-[12px] text-danger-ink">
                {t('ui.storageMeasureFailed', folderError)}
              </p>
            )
          )}
        </div>
      </div>
    </div>
  )
}
