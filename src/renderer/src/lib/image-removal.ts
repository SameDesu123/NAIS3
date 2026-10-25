import type { RemoveImagesResult } from '@shared/types'
import { askConfirmWithCheckbox } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { t } from './i18n'

// "30분간 이 알림 끄기" — 메모리에만 둔다 (재시작하면 다시 묻는다)
const SNOOZE_MS = 30 * 60 * 1000
let snoozedUntil = 0

/**
 * 이미지를 지우기 직전에 부른다. 지우기는 기본이 숨김이라 바로 true.
 * 설정에서 휴지통 보내기를 켰으면 숨김 목록 설명과 함께 한 번 더 묻는다
 */
export async function confirmImageRemoval(): Promise<boolean> {
  const { value } = await window.nais.invoke('settings:get', { key: 'delete_to_trash' })
  if (value !== '1' || Date.now() < snoozedUntil) return true
  const { ok, checked } = await askConfirmWithCheckbox(t('ui.moveToTrash'), {
    message: t('ui.movesTheFilesToTheSystemTrashWhenOffDeletingOnlyHidesThem'),
    confirmLabel: t('ui.moveToTrash'),
    danger: true,
    checkboxLabel: t('ui.dontShowThisAgainFor30Minutes')
  })
  if (checked) snoozedUntil = Date.now() + SNOOZE_MS
  return ok
}

/** 휴지통으로 못 보낸 파일을 알리고 그 id를 돌려준다 — 그 항목은 지워지지 않고 남는다 */
export function failedRemovals(result: RemoveImagesResult): Set<number> {
  const failed = result.results.filter((r) => !r.ok)
  if (failed.length > 0) {
    toast(
      t(
        'ui.keptValueFilesThatCouldNotBeMovedToTheTrash',
        failed.length.toLocaleString(),
        failed[0].error ?? ''
      ),
      'error'
    )
  }
  return new Set(failed.map((r) => r.id))
}
