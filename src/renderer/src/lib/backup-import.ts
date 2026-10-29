import { t } from './i18n'
import { useCharactersStore } from '../stores/characters-store'
import { useFragmentsStore } from '../stores/fragments-store'
import { useGenerationStore } from '../stores/generation-store'
import { useLibraryStore } from '../stores/library-store'
import { usePromptPresetsStore } from '../stores/prompt-presets-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import { useScenesStore } from '../stores/scenes-store'
import { toast } from '../stores/toast-store'

/** 백업 파일을 골라 불러오고 관련 스토어를 새로고침. 불러왔으면 true (설정·온보딩 공용) */
export async function importBackup(): Promise<boolean> {
  const r = await window.nais.invoke('backup:import', undefined)
  if ('canceled' in r) return false
  if ('error' in r) {
    toast(t('ui.importErrorValue', r.error), 'error')
    return false
  }
  toast(r.summary, 'success')
  // 관련 스토어 새로고침
  void useCharactersStore.getState().load()
  void useFragmentsStore.getState().load()
  void useVibesStore.getState().load()
  void useCharRefsStore.getState().load()
  void usePromptPresetsStore.getState().load()
  void useScenesStore.getState().loadPresets()
  useLibraryStore.getState().openStack(null)
  // 메인 프롬프트가 바뀌었으면 재하이드레이트
  if (r.needsPromptReload) void useGenerationStore.getState().hydrate()
  return true
}
