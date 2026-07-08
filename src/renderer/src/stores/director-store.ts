import { create } from 'zustand'
import type { DirectorMethod } from '@shared/types'
import { useGenerationStore } from './generation-store'
import { useLayoutStore } from './layout-store'
import { toast } from './toast-store'

interface DirectorState {
  /** 이미지 스택(base64) — 마지막이 현재. 툴 적용 시 결과가 자동으로 push되어 이어서 처리 */
  stack: string[]
  loading: boolean
  error: string | null

  /** 현재 이미지 (스택 top) */
  current: () => string | null
  setSource: (base64: string | null) => void
  run: (method: DirectorMethod, opts?: { prompt?: string; defry?: number }) => Promise<void>
  upscale: (scale: number) => Promise<void>
  undo: () => void
  clear: () => void
}

export const useDirectorStore = create<DirectorState>((set, get) => ({
  stack: [],
  loading: false,
  error: null,

  current: () => {
    const s = get().stack
    return s.length > 0 ? s[s.length - 1] : null
  },
  setSource: (base64) => set({ stack: base64 ? [base64] : [], error: null }),

  run: async (method, opts) => {
    const cur = get().current()
    if (!cur || get().loading) return
    set({ loading: true, error: null })

    const res = await window.nais.invoke('director:run', {
      method,
      imageBase64: cur,
      prompt: opts?.prompt,
      defry: opts?.defry
    })
    if ('error' in res) {
      set({ loading: false, error: null })
      toast(res.error, 'error')
      return
    }
    // 결과를 스택에 push → 자동으로 다음 입력이 됨 (이어서 처리)
    set({ loading: false, stack: [...get().stack, res.base64] })
    void useGenerationStore.getState().refreshHistory()
  },

  upscale: async (scale) => {
    const cur = get().current()
    if (!cur || get().loading) return
    set({ loading: true, error: null })
    const res = await window.nais.invoke('images:upscale', { imageBase64: cur, scale })
    if ('error' in res) {
      set({ loading: false, error: null })
      toast(res.error, 'error')
      return
    }
    set({ loading: false, stack: [...get().stack, res.base64] })
    void useGenerationStore.getState().refreshHistory()
  },

  undo: () => {
    const s = get().stack
    if (s.length > 1) set({ stack: s.slice(0, -1), error: null })
  },

  clear: () => {
    const stack = get().stack
    const gen = useGenerationStore.getState()
    if (gen.source && stack.includes(gen.source.imageBase64)) gen.setSource(null)
    if (gen.inpaintTarget && stack.includes(gen.inpaintTarget.base64)) gen.cancelInpaint()
    set({ stack: [], error: null })
  }
}))

/** 히스토리 등에서 이미지를 디렉터 툴로 열기 (base64 로드 후 페이지 전환) */
export async function openInDirector(filePath: string): Promise<void> {
  const res = await window.nais.invoke('images:readForSource', { filePath })
  if ('error' in res) {
    toast(res.error, 'error')
    return
  }
  useDirectorStore.getState().setSource(res.base64)
  useLayoutStore.getState().setCenterMode('director')
}
