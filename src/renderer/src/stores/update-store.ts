import { create } from 'zustand'
import type { IpcEventMap } from '@shared/types'
import { notify } from '../lib/notifications'
import { t } from '../lib/i18n'

type UpdateStatus = IpcEventMap['update:status']

interface UpdateState {
  status: UpdateStatus['state'] | 'idle'
  version?: string
  message?: string
  percent: number
  start: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  percent: 0,
  start: () => {
    set({ status: 'downloading', percent: 0 })
    void window.nais.invoke('update:start', undefined)
  }
}))

/** update:status 이벤트 구독 — App 마운트 시 1회 */
export function bindUpdateEvents(): () => void {
  return window.nais.on('update:status', (s) => {
    const previous = useUpdateStore.getState()
    useUpdateStore.setState({
      status: s.state,
      version: s.version ?? previous.version,
      percent: s.percent ?? previous.percent,
      message: s.state === 'error' ? s.message : undefined
    })
    // Progress remains in the titlebar/settings; only meaningful transitions notify.
    if (
      s.state === previous.status &&
      (s.version ?? previous.version) === previous.version &&
      (s.state !== 'error' || s.message === previous.message)
    )
      return
    if (s.state === 'available') {
      notify(t('ui.updateToVersionValue', s.version ?? ''), 'info', { category: 'update' })
    } else if (s.state === 'downloaded') {
      notify(t('ui.installingUpdateRestartingSoon'), 'info', { category: 'update' })
    } else if (s.state === 'error') {
      notify(t('ui.notificationUpdateFailed', s.message ?? ''), 'error', { category: 'update' })
    }
  })
}
