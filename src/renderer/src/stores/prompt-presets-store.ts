import { create } from 'zustand'
import type { GenerationRequest, PresetParams, PromptPreset } from '@shared/types'
import { useGenerationStore } from './generation-store'

/** 프리셋에 함께 저장/복원되는 파라미터 (시드·캐릭터 제외) */
export function pickPresetParams(req: GenerationRequest): PresetParams {
  return {
    model: req.model,
    width: req.width,
    height: req.height,
    steps: req.steps,
    cfgScale: req.cfgScale,
    cfgRescale: req.cfgRescale,
    sampler: req.sampler,
    noiseSchedule: req.noiseSchedule,
    variety: req.variety,
    qualityToggle: req.qualityToggle,
    ucPreset: req.ucPreset
  }
}

interface PromptPresetsState {
  presets: PromptPreset[]
  loaded: boolean
  /** 활성 프리셋 — 메인 프롬프트 편집이 여기로 자동 저장된다 (NAIS2 방식) */
  activeId: number | null
  setActive: (id: number | null) => void
  load: () => Promise<void>
  create: (
    name: string,
    prompt: string,
    negativePrompt: string,
    params?: PresetParams
  ) => Promise<number>
  update: (
    id: number,
    patch: Partial<Pick<PromptPreset, 'name' | 'prompt' | 'negativePrompt' | 'params'>>
  ) => Promise<void>
  /** 드래그 정렬 — 새 id 순서 반영 */
  reorder: (ids: number[]) => Promise<void>
  remove: (id: number) => Promise<void>
}

export const usePromptPresetsStore = create<PromptPresetsState>((set, get) => ({
  presets: [],
  loaded: false,
  activeId: Number(localStorage.getItem('prompt_preset_active')) || null,
  setActive: (activeId) => {
    set({ activeId })
    if (activeId == null) localStorage.removeItem('prompt_preset_active')
    else localStorage.setItem('prompt_preset_active', String(activeId))
  },
  load: async () => {
    const { items } = await window.nais.invoke('promptPresets:list', undefined)
    set({ presets: items, loaded: true })
    // 삭제 등으로 사라진 활성 프리셋 정리
    const { activeId } = get()
    if (activeId != null && !items.some((p) => p.id === activeId)) get().setActive(null)
  },
  create: async (name, prompt, negativePrompt, params) => {
    const { id } = await window.nais.invoke('promptPresets:create', {
      name,
      prompt,
      negativePrompt,
      params
    })
    await get().load()
    return id
  },
  update: async (id, patch) => {
    set({ presets: get().presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
    await window.nais.invoke('promptPresets:update', { id, patch })
  },
  reorder: async (ids) => {
    const byId = new Map(get().presets.map((p) => [p.id, p]))
    set({ presets: ids.map((id) => byId.get(id)!).filter(Boolean) })
    await window.nais.invoke('promptPresets:reorder', { ids })
  },
  remove: async (id) => {
    const { presets, activeId } = get()
    const idx = presets.findIndex((p) => p.id === id)
    const rest = presets.filter((p) => p.id !== id)
    set({ presets: rest })
    await window.nais.invoke('promptPresets:delete', { id })
    if (activeId !== id) return
    // 활성 프리셋을 삭제한 경우 — 편집 내용이 어디에도 저장 안 되는 상태를 만들지 않는다:
    if (rest.length > 0) {
      // 1) 이전 프리셋(없으면 첫 번째)으로 자동 전환 + 적용
      const next = rest[Math.max(0, idx - 1)]
      get().setActive(next.id)
      useGenerationStore
        .getState()
        .patchRequest({ prompt: next.prompt, negativePrompt: next.negativePrompt })
    } else {
      // 2) 전부 삭제됐으면 기본 프리셋을 새로 만들어 활성화 (빈 프롬프트)
      const newId = await get().create('기본', '', '')
      get().setActive(newId)
      useGenerationStore.getState().patchRequest({ prompt: '', negativePrompt: '' })
    }
  }
}))
