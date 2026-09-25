import { create } from 'zustand'
import { recordNav } from '../lib/nav-history'

export type CenterMode = 'main' | 'scene' | 'director' | 'library' | 'websearch'

interface LayoutState {
  leftOpen: boolean
  rightOpen: boolean
  settingsOpen: boolean
  centerMode: CenterMode
  /** 좌측 사이드바 폭 (드래그로 조절, 영속) */
  sidebarWidth: number
  /** 상단 탭에서 숨긴 페이지 (메인은 숨길 수 없음) */
  hiddenPages: CenterMode[]
  quickGenerationControlsEnabled: boolean
  toggleLeft: () => void
  toggleRight: () => void
  setSettingsOpen: (open: boolean) => void
  setCenterMode: (mode: CenterMode) => void
  setSidebarWidth: (w: number) => void
  setPageHidden: (page: CenterMode, hidden: boolean) => void
  setQuickGenerationControlsEnabled: (enabled: boolean) => void
  hydrate: () => Promise<void>
}

export const SIDEBAR_MIN = 340
export const SIDEBAR_MAX = 640

function persist(key: string, value: boolean): void {
  void window.nais.invoke('settings:set', { key, value: value ? '1' : '0' })
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  leftOpen: true,
  rightOpen: true,
  settingsOpen: false,
  centerMode: 'main',
  sidebarWidth: Math.min(
    SIDEBAR_MAX,
    Math.max(SIDEBAR_MIN, Number(localStorage.getItem('sidebar_width')) || 400)
  ),
  setSidebarWidth: (w) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)))
    set({ sidebarWidth: clamped })
    localStorage.setItem('sidebar_width', String(clamped))
  },
  hiddenPages: [],
  quickGenerationControlsEnabled: false,
  setQuickGenerationControlsEnabled: (quickGenerationControlsEnabled) => {
    set({ quickGenerationControlsEnabled })
    persist('ui_quick_generation_controls', quickGenerationControlsEnabled)
  },
  setCenterMode: (centerMode) => {
    if (centerMode !== get().centerMode) recordNav() // 마우스 뒤로/앞으로용 히스토리
    set({ centerMode })
  },
  setPageHidden: (page, hidden) => {
    if (page === 'main') return // 메인은 항상 표시
    const hiddenPages = hidden
      ? [...new Set([...get().hiddenPages, page])]
      : get().hiddenPages.filter((p) => p !== page)
    set({ hiddenPages })
    void window.nais.invoke('settings:set', {
      key: 'ui_hidden_pages',
      value: JSON.stringify(hiddenPages)
    })
    // 지금 보고 있는 탭을 숨기면 메인으로
    if (hidden && get().centerMode === page) get().setCenterMode('main')
  },
  toggleLeft: () => {
    const leftOpen = !get().leftOpen
    set({ leftOpen })
    persist('ui_left_open', leftOpen)
  },
  toggleRight: () => {
    const rightOpen = !get().rightOpen
    set({ rightOpen })
    persist('ui_right_open', rightOpen)
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  hydrate: async () => {
    const [left, right, hidden, quickGenerationControls] = await Promise.all([
      window.nais.invoke('settings:get', { key: 'ui_left_open' }),
      window.nais.invoke('settings:get', { key: 'ui_right_open' }),
      window.nais.invoke('settings:get', { key: 'ui_hidden_pages' }),
      window.nais.invoke('settings:get', { key: 'ui_quick_generation_controls' })
    ])
    let hiddenPages: CenterMode[] = []
    try {
      if (hidden.value) hiddenPages = JSON.parse(hidden.value) as CenterMode[]
    } catch {
      // 손상된 값은 무시
    }
    set({
      leftOpen: left.value !== '0',
      rightOpen: right.value !== '0',
      hiddenPages,
      quickGenerationControlsEnabled: quickGenerationControls.value === '1'
    })
  }
}))
