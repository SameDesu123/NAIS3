import { create } from 'zustand'
import {
  fitNaiGenerationResolution,
  snapNaiDimension,
  type ResolutionDimension
} from '@shared/nai-resolution'

export interface CustomResolution {
  label: string
  width: number
  height: number
}

interface ResolutionsState {
  custom: CustomResolution[]
  add: (
    width: number,
    height: number,
    preservedDimension?: ResolutionDimension
  ) => CustomResolution | null
  remove: (index: number) => void
}

const KEY = 'custom_resolutions'

function load(): CustomResolution[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
function save(list: CustomResolution[]): void {
  localStorage.setItem(KEY, JSON.stringify(list))
}

export const snapDim = snapNaiDimension

export const useResolutionsStore = create<ResolutionsState>((set, get) => ({
  custom: load(),
  add: (width, height, preservedDimension = 'height') => {
    const fitted = fitNaiGenerationResolution(width, height, preservedDimension)
    if (!fitted) return null
    const { width: w, height: h } = fitted
    // 이미 있으면(기본/커스텀 무관) 추가 안 함 — 중복 방지는 UI에서, 여기선 커스텀 중복만 체크
    if (get().custom.some((r) => r.width === w && r.height === h)) return null
    const item = { label: `${w}×${h}`, width: w, height: h }
    const next = [...get().custom, item]
    set({ custom: next })
    save(next)
    return item
  },
  remove: (index) => {
    const next = get().custom.filter((_, i) => i !== index)
    set({ custom: next })
    save(next)
  }
}))
