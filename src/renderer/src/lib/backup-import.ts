import { create } from 'zustand'
import { t } from './i18n'
import { useCharactersStore } from '../stores/characters-store'
import { useFragmentsStore } from '../stores/fragments-store'
import { useGenerationStore } from '../stores/generation-store'
import { useLibraryStore } from '../stores/library-store'
import { usePromptPresetsStore } from '../stores/prompt-presets-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import { useScenesStore } from '../stores/scenes-store'
import { toast } from '../stores/toast-store'

interface BackupRestoreState {
  /** From the start of a restore until this window's stores hold the restored data */
  restoring: boolean
}

export const useBackupRestoreStore = create<BackupRestoreState>(() => ({ restoring: false }))

let storesReloaded: Promise<void> = Promise.resolve()

/** Re-reads every store a restore replaces */
export async function reloadWorkspaceStores(): Promise<void> {
  useLibraryStore.getState().openStack(null)
  await Promise.allSettled([
    useCharactersStore.getState().load(),
    useFragmentsStore.getState().load(),
    useVibesStore.getState().load(),
    useCharRefsStore.getState().load(),
    usePromptPresetsStore.getState().load(),
    useScenesStore.getState().loadPresets(),
    useGenerationStore.getState().hydrate()
  ])
}

/**
 * Follows the restore lock the runtime owns (main process on desktop). Bound once at startup,
 * so a window reloaded mid-restore finds the lock again, stays blocked, and still reloads its
 * stores when the restore ends.
 */
export function bindBackupRestore(): () => void {
  const off = window.nais.on('backup:restoreChanged', ({ restoring }) => {
    if (restoring) {
      useBackupRestoreStore.setState({ restoring: true })
      return
    }
    // Stay blocked until the stores are fresh — an edit on a stale row would write over the restore
    storesReloaded = reloadWorkspaceStores().finally(() =>
      useBackupRestoreStore.setState({ restoring: false })
    )
  })
  void window.nais.invoke('backup:restoreStatus', undefined).then(({ restoring }) => {
    if (restoring) useBackupRestoreStore.setState({ restoring: true })
  })
  return off
}

/** 백업 파일을 골라 불러온다. 불러왔으면 true (설정·온보딩 공용) */
export async function importBackup(): Promise<boolean> {
  const r = await window.nais.invoke('backup:import', undefined)
  if ('canceled' in r) return false
  // The end event is sent before this reply; wait for the reload it started
  await storesReloaded
  if ('error' in r) {
    toast(t('ui.importErrorValue', r.error), 'error')
    return false
  }
  toast(r.summary, 'success')
  return true
}
